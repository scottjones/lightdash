import { ApiError } from '@lightdash/common';
import { useQuery } from 'react-query';
import { UseQueryOptions } from 'react-query/types/react/types';
import {
    createMetricFlowQuery,
    CreateMetricFlowQueryResponse,
    getMetricFlowQueryResults,
    GetMetricFlowQueryResultsResponse,
    QueryStatus,
} from '../../../api/MetricFlowAPI';

type ApiRequestsState = Pick<
    ReturnType<typeof useQuery<GetMetricFlowQueryResultsResponse, ApiError>>,
    'isLoading' | 'data' | 'error' | 'status'
> &
    Pick<
        ReturnType<typeof useQuery<CreateMetricFlowQueryResponse, ApiError>>,
        'refetch'
    >;

const useMetricFlowQueryResults = (
    projectUuid: string | undefined,
    query?: {
        metrics: string[];
        dimensions: string[];
    },
    useCreateQueryOptions?: UseQueryOptions<
        CreateMetricFlowQueryResponse,
        ApiError
    >,
    useResultQueryOptions?: UseQueryOptions<
        GetMetricFlowQueryResultsResponse,
        ApiError
    >,
): ApiRequestsState => {
    const metricFlowQuery = useQuery<CreateMetricFlowQueryResponse, ApiError>({
        queryKey: ['metric_flow_query', projectUuid, query],
        enabled: !!projectUuid && !!query?.metrics.length,
        queryFn: () => createMetricFlowQuery(projectUuid!, query!),
        ...useCreateQueryOptions,
    });
    const queryId = metricFlowQuery.data?.createQuery.queryId;
    const metricFlowQueryResultsQuery = useQuery<
        GetMetricFlowQueryResultsResponse,
        ApiError
    >({
        queryKey: ['metric_flow_query_results', projectUuid, queryId],
        enabled: !!projectUuid && !!queryId && metricFlowQuery.isSuccess,
        queryFn: () => getMetricFlowQueryResults(projectUuid!, queryId!),
        refetchInterval: (refetchData) => {
            return refetchData === undefined ||
                [QueryStatus.SUCCESSFUL, QueryStatus.FAILED].includes(
                    refetchData.query.status,
                )
                ? false
                : 500;
        },
        ...useResultQueryOptions,
    });

    const isResultsQueryRefetching =
        !!metricFlowQueryResultsQuery.data &&
        ![QueryStatus.SUCCESSFUL, QueryStatus.FAILED].includes(
            metricFlowQueryResultsQuery.data?.query.status,
        );

    if (isResultsQueryRefetching) {
        return {
            isLoading: true,
            error: null,
            data: undefined,
            status: 'loading',
            refetch: metricFlowQuery.refetch,
        };
    }

    if (metricFlowQueryResultsQuery.data?.query.status === QueryStatus.FAILED) {
        return {
            isLoading: false,
            error: {
                status: 'error',
                error: {
                    name: 'ApiError',
                    statusCode: 500,
                    message:
                        metricFlowQueryResultsQuery.data.query.error ||
                        'Unknown error',
                    data: {},
                },
            },
            data: undefined,
            status: 'error',
            refetch: metricFlowQuery.refetch,
        };
    }

    return {
        isLoading:
            metricFlowQuery.isLoading || metricFlowQueryResultsQuery.isLoading,
        error: metricFlowQuery.error || metricFlowQueryResultsQuery.error,
        data: metricFlowQueryResultsQuery.data,
        status: metricFlowQuery.isLoading
            ? metricFlowQuery.status
            : metricFlowQueryResultsQuery.status,
        refetch: metricFlowQuery.refetch,
    };
};

export default useMetricFlowQueryResults;
