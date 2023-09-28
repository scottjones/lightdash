import { subject } from '@casl/ability';
import {
    addDashboardFiltersToMetricQuery,
    ApiSqlQueryResults,
    DashboardFilters,
    DimensionType,
    DownloadCsvPayload,
    DownloadMetricCsv,
    Field,
    ForbiddenError,
    formatItemValue,
    friendlyName,
    getCustomLabelsFromTableConfig,
    getDashboardFiltersForTile,
    getItemLabel,
    getItemLabelWithoutTableName,
    getItemMap,
    isDashboardChartTileType,
    isField,
    isMomentInput,
    isTableChartConfig,
    MetricQuery,
    SchedulerCsvOptions,
    SchedulerFormat,
    SessionUser,
    TableCalculation,
} from '@lightdash/common';

import { stringify } from 'csv-stringify';
import * as fs from 'fs';
import * as fsPromise from 'fs/promises';

import moment, { MomentInput } from 'moment';
import { nanoid } from 'nanoid';
import { pipeline, Readable, Transform, TransformCallback } from 'stream';
import { Worker } from 'worker_threads';
import { analytics } from '../../analytics/client';
import {
    DownloadCsv,
    parseAnalyticsLimit,
    QueryExecutionContext,
} from '../../analytics/LightdashAnalytics';
import { S3Service } from '../../clients/Aws/s3';
import { schedulerClient } from '../../clients/clients';
import { AttachmentUrl } from '../../clients/EmailClient/EmailClient';
import { LightdashConfig } from '../../config/parseConfig';
import Logger from '../../logging/logger';
import { DashboardModel } from '../../models/DashboardModel/DashboardModel';
import { SavedChartModel } from '../../models/SavedChartModel';
import { UserModel } from '../../models/UserModel';
import { runWorkerThread } from '../../utils';
import { ProjectService } from '../ProjectService/ProjectService';

type CsvServiceDependencies = {
    lightdashConfig: LightdashConfig;

    projectService: ProjectService;
    s3Service: S3Service;
    savedChartModel: SavedChartModel;
    dashboardModel: DashboardModel;
    userModel: UserModel;
};

const isRowValueTimestamp = (
    value: unknown,
    field: { type: DimensionType },
): value is MomentInput =>
    isMomentInput(value) && field.type === DimensionType.TIMESTAMP;

const isRowValueDate = (
    value: unknown,
    field: { type: DimensionType },
): value is MomentInput =>
    isMomentInput(value) && field.type === DimensionType.DATE;

export const convertSqlToCsv = (
    results: ApiSqlQueryResults,
    customLabels: Record<string, string> = {},
): Promise<string> => {
    const csvHeader = Object.keys(results.rows[0]).map(
        (id) => customLabels[id] || friendlyName(id),
    );
    const csvBody = results?.rows.map((row) =>
        Object.values(results?.fields).map((field, fieldIndex) => {
            const rowValue = Object.values(row)[fieldIndex];

            if (isRowValueTimestamp(rowValue, field)) {
                return moment(rowValue).format('YYYY-MM-DD HH:mm:ss');
            }
            if (isRowValueDate(rowValue, field)) {
                return moment(rowValue).format('YYYY-MM-DD');
            }

            return Object.values(row)[fieldIndex];
        }),
    );
    return new Promise((resolve, reject) => {
        stringify(
            [csvHeader, ...csvBody],
            {
                delimiter: ',',
            },
            (err, output) => {
                if (err) {
                    reject(new Error(err.message));
                }
                resolve(output);
            },
        );
    });
};

const getSchedulerCsvLimit = (
    options: SchedulerCsvOptions | undefined,
): number | null | undefined => {
    switch (options?.limit) {
        case 'table':
        case undefined:
            return undefined;
        case 'all':
            return null;
        default:
            // Custom
            return options?.limit;
    }
};

export class CsvService {
    lightdashConfig: LightdashConfig;

    projectService: ProjectService;

    s3Service: S3Service;

    savedChartModel: SavedChartModel;

    dashboardModel: DashboardModel;

    userModel: UserModel;

    constructor({
        lightdashConfig,
        userModel,
        projectService,
        s3Service,
        savedChartModel,
        dashboardModel,
    }: CsvServiceDependencies) {
        this.lightdashConfig = lightdashConfig;
        this.userModel = userModel;
        this.projectService = projectService;
        this.s3Service = s3Service;
        this.savedChartModel = savedChartModel;
        this.dashboardModel = dashboardModel;
    }

    static convertRowToCsv(
        row: Record<string, any>,
        itemMap: Record<string, Field | TableCalculation>,
        onlyRaw: boolean,
        sortedFieldIds: string[],
    ) {
        return sortedFieldIds.map((id: string) => {
            const data = row[id];
            const item = itemMap[id];

            if (data === null || data === undefined) {
                return data;
            }

            const itemIsField = isField(item);
            if (itemIsField && item.type === DimensionType.TIMESTAMP) {
                return moment(data).format('YYYY-MM-DD HH:mm:ss');
            }
            if (itemIsField && item.type === DimensionType.DATE) {
                return moment(data).format('YYYY-MM-DD');
            }

            // Return raw value and let csv-stringify handle the rest
            if (onlyRaw) return data;

            // Use standard Lightdash formatting based on the item formatting configuration
            return formatItemValue(item, data);
        });
    }

    static generateFileId(
        fileName: string,
        truncated: boolean = false,
        time: moment.Moment = moment(),
    ): string {
        const timestamp = time.format('YYYY-MM-DD-HH-mm-ss-SSSS');
        const sanitizedFileName = fileName
            .toLowerCase()
            .replace(/[^a-z0-9]/gi, '_') // Replace non-alphanumeric characters with underscores
            .replace(/_{2,}/g, '_'); // Replace multiple underscores with a single one
        const fileId = `csv-${
            truncated ? 'incomplete_results-' : ''
        }${sanitizedFileName}-${timestamp}.csv`;
        return fileId;
    }

    static async writeRowsToFile(
        rows: Record<string, any>[],
        onlyRaw: boolean,
        metricQuery: MetricQuery,
        itemMap: Record<string, Field | TableCalculation>,
        showTableNames: boolean,
        fileName: string,
        truncated: boolean,
        customLabels: Record<string, string> = {},
        columnOrder: string[] = [],
    ): Promise<string> {
        // Ignore fields from results that are not selected in metrics or dimensions
        const selectedFieldIds = [
            ...metricQuery.metrics,
            ...metricQuery.dimensions,
            ...metricQuery.tableCalculations.map((tc: any) => tc.name),
        ];
        Logger.debug(
            `writeRowsToFile with ${rows.length} rows and ${selectedFieldIds.length} columns`,
        );

        const fileId = CsvService.generateFileId(fileName, truncated);
        const writeStream = fs.createWriteStream(`/tmp/${fileId}`);

        const sortedFieldIds = Object.keys(rows[0])
            .filter((id) => selectedFieldIds.includes(id))
            .sort((a, b) => columnOrder.indexOf(a) - columnOrder.indexOf(b));

        const csvHeader = sortedFieldIds.map((id) => {
            if (customLabels[id]) {
                return customLabels[id];
            }
            if (itemMap[id]) {
                return showTableNames
                    ? getItemLabel(itemMap[id])
                    : getItemLabelWithoutTableName(itemMap[id]);
            }
            return id;
        });

        // Increasing CHUNK_SIZE increases memory usage, but increases speed of CSV generation
        const CHUNK_SIZE = 50000;
        const readStream = Readable.from(rows, {
            objectMode: true,
            highWaterMark: CHUNK_SIZE,
        });

        const stringifier = stringify({
            delimiter: ',',
            header: true,
            columns: csvHeader,
        });

        const rowTransformer = new Transform({
            objectMode: true,
            transform(
                chunk: any,
                encoding: BufferEncoding,
                callback: TransformCallback,
            ) {
                callback(
                    null,
                    CsvService.convertRowToCsv(
                        chunk,
                        itemMap,
                        onlyRaw,
                        sortedFieldIds,
                    ),
                );
            },
        });

        const writePromise = new Promise<string>((resolve, reject) => {
            pipeline(
                readStream,
                rowTransformer,
                stringifier,
                writeStream,
                async (err) => {
                    if (err) {
                        reject(err);
                    }
                    resolve(fileId);
                },
            );
        });

        return writePromise;
    }

    static async convertSqlQueryResultsToCsv(
        results: ApiSqlQueryResults,
        customLabels: Record<string, string> | undefined,
    ): Promise<string> {
        if (results.rows.length > 500) {
            Logger.debug(
                `Using worker to format csv with ${results.rows.length} lines`,
            );
            return runWorkerThread<string>(
                new Worker('./dist/services/CsvService/convertSqlToCsv.js', {
                    workerData: {
                        results,
                        customLabels,
                    },
                }),
            );
        }
        return convertSqlToCsv(results, customLabels);
    }

    couldBeTruncated(rows: Record<string, any>[]) {
        if (rows.length === 0) return false;

        const numberRows = rows.length;
        const numberColumns = Object.keys(rows[0]).length;

        // we use floor when limiting the rows, so the  need to make sure we got the last row valid
        const cellsLimit = this.lightdashConfig.query?.csvCellsLimit || 100000;

        return numberRows * numberColumns >= cellsLimit - numberColumns;
    }

    async getCsvForChart(
        user: SessionUser,
        chartUuid: string,
        options: SchedulerCsvOptions | undefined,
        jobId?: string,
        tileUuid?: string,
        dashboardFilters?: DashboardFilters,
    ): Promise<AttachmentUrl> {
        const chart = await this.savedChartModel.get(chartUuid);
        const {
            metricQuery,
            chartConfig: { config },
        } = chart;
        const exploreId = chart.tableName;
        const onlyRaw = options?.formatted === false;

        const analyticProperties: DownloadCsv['properties'] | undefined = jobId
            ? {
                  jobId,
                  userId: user.userUuid,
                  organizationId: user.organizationUuid,
                  projectId: chart.projectUuid,
                  fileType: SchedulerFormat.CSV,
                  values: onlyRaw ? 'raw' : 'formatted',
                  limit: parseAnalyticsLimit(options?.limit),
                  storage: this.s3Service.isEnabled() ? 's3' : 'local',
                  context: 'scheduled delivery chart',
                  numColumns:
                      metricQuery.dimensions.length +
                      metricQuery.metrics.length +
                      metricQuery.tableCalculations.length,
              }
            : undefined;

        if (analyticProperties) {
            analytics.track({
                event: 'download_results.started',
                userId: user.userUuid,
                properties: analyticProperties,
            });
        }

        const explore = await this.projectService.getExplore(
            user,
            chart.projectUuid,
            exploreId,
        );

        const dashboardFiltersForTile =
            tileUuid && dashboardFilters
                ? getDashboardFiltersForTile(
                      tileUuid,
                      Object.keys(explore.tables),
                      dashboardFilters,
                  )
                : undefined;

        const metricQueryWithDashboardFilters = dashboardFiltersForTile
            ? addDashboardFiltersToMetricQuery(
                  metricQuery,
                  dashboardFiltersForTile,
              )
            : metricQuery;

        const rows = await this.projectService.runMetricQuery(
            user,
            metricQueryWithDashboardFilters,
            chart.projectUuid,
            exploreId,
            getSchedulerCsvLimit(options),
            QueryExecutionContext.CSV,
        );
        const numberRows = rows.length;

        if (numberRows === 0)
            return {
                path: '#no-results',
                filename: `${chart.name} (empty)`,
                localPath: '',
                truncated: true,
            };

        const itemMap = getItemMap(
            explore,
            metricQueryWithDashboardFilters.additionalMetrics,
            metricQueryWithDashboardFilters.tableCalculations,
        );
        const truncated = this.couldBeTruncated(rows);

        const fileId = await CsvService.writeRowsToFile(
            rows,
            onlyRaw,
            metricQueryWithDashboardFilters,
            itemMap,
            isTableChartConfig(config) ? config.showTableNames ?? false : true,
            chart.name,
            truncated,
            getCustomLabelsFromTableConfig(config),
            chart.tableConfig.columnOrder,
        );

        if (analyticProperties) {
            analytics.track({
                event: 'download_results.completed',
                userId: user.userUuid,
                properties: { ...analyticProperties, numRows: numberRows },
            });
        }

        if (this.s3Service.isEnabled()) {
            const csvContent = await fsPromise.readFile(`/tmp/${fileId}`, {
                encoding: 'utf-8',
            });
            const s3Url = await this.s3Service.uploadCsv(csvContent, fileId);

            // Delete local file in 10 minutes, we could still read from the local file to upload to google sheets
            setTimeout(async () => {
                await fsPromise.unlink(`/tmp/${fileId}`);
            }, 60 * 10 * 1000);
            return {
                filename: `${chart.name}`,
                path: s3Url,
                localPath: `/tmp/${fileId}`,
                truncated,
            };
        }
        // storing locally
        const localUrl = `${this.lightdashConfig.siteUrl}/api/v1/projects/${chart.projectUuid}/csv/${fileId}`;
        return {
            filename: `${chart.name}`,
            path: localUrl,
            localPath: `/tmp/${fileId}`,
            truncated,
        };
    }

    async getCsvsForDashboard(
        user: SessionUser,
        dashboardUuid: string,
        options: SchedulerCsvOptions | undefined,
    ) {
        const dashboard = await this.dashboardModel.getById(dashboardUuid);

        const chartTileUuidsWithChartUuids = dashboard.tiles
            .filter(isDashboardChartTileType)
            .filter((tile) => tile.properties.savedChartUuid)
            .map((tile) => ({
                tileUuid: tile.uuid,
                chartUuid: tile.properties.savedChartUuid!,
            }));

        const csvForChartPromises = chartTileUuidsWithChartUuids.map(
            ({ tileUuid, chartUuid }) =>
                this.getCsvForChart(
                    user,
                    chartUuid,
                    options,
                    undefined,
                    tileUuid,
                    dashboard.filters,
                ),
        );

        const csvUrls = await Promise.all(csvForChartPromises);
        return csvUrls;
    }

    async downloadSqlCsv({
        user,
        projectUuid,
        sql,
        customLabels,
    }: {
        user: SessionUser;
        projectUuid: string;
        sql: string;
        customLabels: Record<string, string> | undefined;
    }) {
        const jobId = nanoid();
        const analyticsProperties: DownloadCsv['properties'] = {
            jobId,
            userId: user.userUuid,
            organizationId: user.organizationUuid,
            projectId: projectUuid,
            tableId: 'sql_runner',
            values: 'raw',
            context: 'sql runner',
            fileType: SchedulerFormat.CSV,
            storage: this.s3Service.isEnabled() ? 's3' : 'local',
        };
        try {
            const { organizationUuid } = user;

            if (
                user.ability.cannot(
                    'manage',
                    subject('ExportCsv', { organizationUuid, projectUuid }),
                )
            ) {
                throw new ForbiddenError();
            }

            analytics.track({
                event: 'download_results.started',
                userId: user.userUuid,
                properties: {
                    ...analyticsProperties,
                },
            });

            const results: ApiSqlQueryResults =
                await this.projectService.runSqlQuery(user!, projectUuid, sql);

            const csvContent = await CsvService.convertSqlQueryResultsToCsv(
                results,
                customLabels,
            );

            const fileId = `csv-${jobId}.csv`;

            let fileUrl;
            if (this.s3Service.isEnabled()) {
                fileUrl = await this.s3Service.uploadCsv(csvContent, fileId);
            } else {
                // storing locally
                await fsPromise.writeFile(
                    `/tmp/${fileId}`,
                    csvContent,
                    'utf-8',
                );
                fileUrl = `${this.lightdashConfig.siteUrl}/api/v1/projects/${projectUuid}/csv/${fileId}`;
            }

            analytics.track({
                event: 'download_results.completed',
                userId: user.userUuid,
                properties: {
                    ...analyticsProperties,
                    numRows: results.rows.length,
                    numColumns: Object.keys(results.fields).length,
                },
            });

            return fileUrl;
        } catch (e) {
            analytics.track({
                event: 'download_results.error',
                userId: user.userUuid,
                properties: {
                    ...analyticsProperties,
                    error: `${e}`,
                },
            });
            throw e;
        }
    }

    static async scheduleDownloadCsv(
        user: SessionUser,
        csvOptions: DownloadMetricCsv,
    ) {
        if (
            user.ability.cannot(
                'manage',
                subject('ExportCsv', {
                    organizationUuid: user.organizationUuid,
                    projectUuid: csvOptions.projectUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }

        const payload: DownloadCsvPayload = {
            ...csvOptions,
            userUuid: user.userUuid,
        };
        const { jobId } = await schedulerClient.downloadCsvJob(payload);

        return { jobId };
    }

    async downloadCsv(
        jobId: string,
        {
            userUuid,
            projectUuid,
            exploreId,
            metricQuery,
            onlyRaw,
            csvLimit,
            showTableNames,
            customLabels,
            columnOrder,
        }: DownloadMetricCsv,
    ) {
        const user = await this.userModel.findSessionUserByUUID(userUuid);

        if (
            user.ability.cannot(
                'manage',
                subject('ExportCsv', {
                    organizationUuid: user.organizationUuid,
                    projectUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }

        const baseAnalyticsProperties: DownloadCsv['properties'] = {
            jobId,
            userId: userUuid,
            organizationId: user.organizationUuid,
            projectId: projectUuid,
            fileType: SchedulerFormat.CSV,
            storage: this.s3Service.isEnabled() ? 's3' : 'local',
        };
        try {
            const numberColumns =
                metricQuery.dimensions.length +
                metricQuery.metrics.length +
                metricQuery.tableCalculations.length;
            const analyticsProperties: DownloadCsv['properties'] = {
                ...baseAnalyticsProperties,
                tableId: exploreId,
                values: onlyRaw ? 'raw' : 'formatted',
                context: 'results',
                limit: parseAnalyticsLimit(csvLimit),

                numColumns: numberColumns,
            };
            analytics.track({
                event: 'download_results.started',
                userId: user.userUuid!,
                properties: analyticsProperties,
            });

            const rows = await this.projectService.runMetricQuery(
                user,
                metricQuery,
                projectUuid,
                exploreId,
                csvLimit,
                QueryExecutionContext.CSV,
            );
            const numberRows = rows.length;

            const explore = await this.projectService.getExplore(
                user,
                projectUuid,
                exploreId,
            );
            const itemMap = getItemMap(
                explore,
                metricQuery.additionalMetrics,
                metricQuery.tableCalculations,
            );
            const truncated = this.couldBeTruncated(rows);

            const fileId = await CsvService.writeRowsToFile(
                rows,
                onlyRaw,
                metricQuery,
                itemMap,
                showTableNames,
                exploreId,
                truncated,
                customLabels,
                columnOrder || [],
            );

            let fileUrl;
            if (this.s3Service.isEnabled()) {
                const csvContent = await fsPromise.readFile(`/tmp/${fileId}`, {
                    encoding: 'utf-8',
                });
                fileUrl = await this.s3Service.uploadCsv(csvContent, fileId);

                await fsPromise.unlink(`/tmp/${fileId}`);
            } else {
                // Storing locally
                fileUrl = `${this.lightdashConfig.siteUrl}/api/v1/projects/${projectUuid}/csv/${fileId}`;
            }

            analytics.track({
                event: 'download_results.completed',
                userId: user.userUuid,
                properties: {
                    ...analyticsProperties,
                    numRows: numberRows,
                },
            });

            return { fileUrl, truncated };
        } catch (e) {
            analytics.track({
                event: 'download_results.error',
                userId: user.userUuid,
                properties: {
                    ...baseAnalyticsProperties,
                    error: `${e}`,
                },
            });

            throw e;
        }
    }
}
