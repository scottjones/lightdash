import { NonIdealState, Spinner } from '@blueprintjs/core';
import { PivotReference } from '@lightdash/common';
import EChartsReact from 'echarts-for-react';
import { EChartsReactProps, Opts } from 'echarts-for-react/lib/types';
import { FC, memo, useCallback, useEffect, useMemo, useState } from 'react';
import useEcharts from '../../hooks/echarts/useEcharts';
import { useVisualizationContext } from '../LightdashVisualization/VisualizationProvider';

type EchartBaseClickEvent = {
    // The component name clicked,
    // component type, could be 'series'、'markLine'、'markPoint'、'timeLine', etc..
    componentType: string;
    // series type, could be 'line'、'bar'、'pie', etc.. Works when componentType is 'series'.
    seriesType: string;
    // the index in option.series. Works when componentType is 'series'.
    seriesIndex: number;
    // series name, works when componentType is 'series'.
    seriesName: string;
    // name of data (categories).
    name: string;
    // the index in 'data' array.
    dataIndex: number;
    // incoming raw data item
    data: Object;
    // charts like 'sankey' and 'graph' included nodeData and edgeData as the same time.
    // dataType can be 'node' or 'edge', indicates whether the current click is on node or edge.
    // most of charts have one kind of data, the dataType is meaningless
    dataType: string;
    // incoming data value
    value: number | Array<any>;
    // color of the shape, works when componentType is 'series'.
    color: string;
    event: { event: MouseEvent };
    pivotReference?: PivotReference;
};

export type EchartSeriesClickEvent = EchartBaseClickEvent & {
    componentType: 'series';
    data: Record<string, any>;
    seriesIndex: number;
    dimensionNames: string[];
    pivotReference?: PivotReference;
};

type EchartClickEvent = EchartSeriesClickEvent | EchartBaseClickEvent;

type LegendClickEvent = {
    selected: {
        [name: string]: boolean;
    };
};

export const EmptyChart = () => (
    <div style={{ height: '100%', width: '100%', padding: '50px 0' }}>
        <NonIdealState
            title="No data available"
            description="Query metrics and dimensions with results."
            icon="chart"
        />
    </div>
);

export const LoadingChart = () => (
    <div style={{ height: '100%', width: '100%', padding: '50px 0' }}>
        <NonIdealState
            title="Loading chart"
            icon={<Spinner />}
            className="loading_chart"
        />
    </div>
);

const isSeriesClickEvent = (e: EchartClickEvent): e is EchartSeriesClickEvent =>
    e.componentType === 'series';

type SimpleChartProps = Omit<EChartsReactProps, 'option'> & {
    isInDashboard: boolean;
    $shouldExpand?: boolean;
    className?: string;
    'data-testid'?: string;
};

const SimpleChart: FC<SimpleChartProps> = memo((props) => {
    const { chartRef, isLoading, onSeriesContextMenu } =
        useVisualizationContext();

    const [selectedLegends, setSelectedLegends] = useState({});

    const [selectedLegendsUpdated, setSelectedLegendsUpdated] = useState({});

    const onLegendChange = useCallback((params: LegendClickEvent) => {
        setSelectedLegends(params.selected);
    }, []);

    useEffect(() => {
        setSelectedLegendsUpdated(selectedLegends);
    }, [selectedLegends]);

    const eChartsOptions = useEcharts(
        selectedLegendsUpdated,
        props.isInDashboard,
    );

    useEffect(() => {
        const listener = () => {
            const eCharts = chartRef.current?.getEchartsInstance();
            eCharts?.resize();
        };

        window.addEventListener('resize', listener);

        return () => window.removeEventListener('resize', listener);
    });

    const onChartContextMenu = useCallback(
        (e: EchartClickEvent) => {
            if (onSeriesContextMenu) {
                if (e.event.event.defaultPrevented) {
                    return;
                }
                e.event.event.preventDefault();
                if (isSeriesClickEvent(e)) {
                    const series = (eChartsOptions?.series || [])[
                        e.seriesIndex
                    ];
                    if (series && series.encode) {
                        onSeriesContextMenu(e, eChartsOptions?.series || []);
                    }
                }
            }
        },
        [onSeriesContextMenu, eChartsOptions],
    );

    const opts = useMemo<Opts>(() => ({ renderer: 'svg' }), []);

    const handleOnMouseOver = useCallback(
        (params) => {
            const eCharts = chartRef.current?.getEchartsInstance();

            if (eCharts) {
                eCharts.setOption({
                    tooltip: {
                        trigger: 'item',
                    },
                });

                // Wait for tooltip to change from `axis` to `item` and keep hovered on item highlighted
                setTimeout(() => {
                    eCharts.dispatchAction({
                        type: 'highlight',
                        seriesIndex: params.seriesIndex,
                    });
                }, 100);
            }
        },
        [chartRef],
    );

    const handleOnMouseOut = useCallback(() => {
        const eCharts = chartRef.current?.getEchartsInstance();

        if (eCharts) {
            eCharts.setOption(
                {
                    tooltip: {
                        trigger: 'axis',
                    },
                },
                false,
                true, // lazy update
            );
        }
    }, [chartRef]);

    if (isLoading) return <LoadingChart />;
    if (!eChartsOptions) return <EmptyChart />;

    return (
        <EChartsReact
            data-testid={props['data-testid']}
            className={props.className}
            style={
                props.$shouldExpand
                    ? {
                          minHeight: 'inherit',
                          height: '100%',
                          width: '100%',
                      }
                    : {
                          minHeight: 'inherit',
                          // height defaults to 300px
                          width: '100%',
                      }
            }
            ref={chartRef}
            option={eChartsOptions}
            notMerge
            opts={opts}
            onEvents={{
                contextmenu: onChartContextMenu,
                click: onChartContextMenu,
                mouseover: handleOnMouseOver,
                mouseout: handleOnMouseOut,
                legendselectchanged: onLegendChange,
            }}
            {...props}
        />
    );
});

export default SimpleChart;
