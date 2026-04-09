import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Dimensions, Platform } from 'react-native';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
import Svg, { Path, Line, Rect, Text as SvgText } from 'react-native-svg';
import { ChannelDisplay } from '../hooks/useEEGSession';

const BUFFER_SIZE    = 1280;
const DISPLAY_STRIDE = 4;
const AMPLITUDE_UV   = 100;
const LABEL_WIDTH    = 44;
const LANE_PADDING   = 6;

const { height: SCREEN_H } = Dimensions.get('window');
const LANE_HEIGHT = Math.max(52, Math.min(80, Math.floor(SCREEN_H / 12)));

const CLR = {
  bg        : '#090915',
  laneBorder: '#141430',
  zeroLine  : '#1A1A40',
  axisText  : '#334466',
  noSignal  : '#1A2A3A',
  timeTick  : '#222244',
};

interface MultiChannelChartProps {
  channels     : ChannelDisplay[];
  isConnected  : boolean;
  /** When false the component renders nothing, saving 100% GPU resources. */
  graphEnabled ?: boolean;
}

function buildLanePath(
  data    : Float32Array,
  w       : number,
  laneH   : number,
  laneTop : number,
): string {
  if (data.length === 0) return '';

  const xStep = w / (BUFFER_SIZE - 1);
  const halfH = laneH / 2 - LANE_PADDING;
  const midY  = laneTop + laneH / 2;
  const nPts  = Math.ceil(data.length / DISPLAY_STRIDE);
  const parts = new Array<string>(nPts);

  for (let j = 0; j < nPts; j++) {
    const i       = j * DISPLAY_STRIDE;
    const px      = Math.round(i * xStep);
    const v       = data[i];
    const clamped = v < -AMPLITUDE_UV ? -AMPLITUDE_UV
                  : v >  AMPLITUDE_UV ?  AMPLITUDE_UV : v;
    const py      = Math.round(midY - (clamped / AMPLITUDE_UV) * halfH);
    parts[j] = j === 0 ? `M${px},${py}` : `L${px},${py}`;
  }
  return parts.join('');
}

const MultiChannelChart: React.FC<MultiChannelChartProps> = React.memo(
  ({ channels, isConnected, graphEnabled = true }) => {

    // Return null immediately — React skips reconciliation entirely, saving GPU.
    if (!graphEnabled) return null;

    const screenWidth = Dimensions.get('window').width;
    const chartWidth  = screenWidth - LABEL_WIDTH - 8;
    const nChannels   = channels.length;
    const totalH      = Math.max(nChannels * LANE_HEIGHT, LANE_HEIGHT);

    const paths = useMemo(
      () => channels.map((ch, i) =>
        buildLanePath(ch.data, chartWidth, LANE_HEIGHT, i * LANE_HEIGHT)
      ),
      [channels, chartWidth],
    );

    const timeTicks = useMemo(
      () => [0, 1, 2, 3, 4, 5].map(s => ({
        x    : (s / 5) * chartWidth,
        label: s === 0 ? '' : `${s}s`,
      })),
      [chartWidth],
    );

    return (
      <View style={styles.wrapper}>
        <View style={[styles.labelCol, { height: totalH }]}>
          {channels.map((ch, i) => (
            <View
              key={ch.name}
              style={[styles.labelCell, { top: i * LANE_HEIGHT, height: LANE_HEIGHT }]}
            >
              <Text style={[styles.chLabel, { color: ch.color }]} numberOfLines={1}>
                {ch.name}
              </Text>
            </View>
          ))}
        </View>

        <Svg width={chartWidth} height={totalH + 16}>
          <Rect x={0} y={0} width={chartWidth} height={totalH} fill={CLR.bg} />

          {channels.map((ch, i) => {
            const laneTop = i * LANE_HEIGHT;
            const midY    = laneTop + LANE_HEIGHT / 2;
            return (
              <React.Fragment key={ch.name}>
                {i > 0 && (
                  <Line
                    x1={0} y1={laneTop} x2={chartWidth} y2={laneTop}
                    stroke={CLR.laneBorder} strokeWidth={1}
                  />
                )}
                <Line
                  x1={0} y1={midY} x2={chartWidth} y2={midY}
                  stroke={CLR.zeroLine} strokeWidth={0.8}
                  strokeDasharray="6,6"
                />
                <Path
                  d={paths[i]}
                  stroke={isConnected ? ch.color : CLR.noSignal}
                  strokeWidth={1.3}
                  fill="none"
                />
              </React.Fragment>
            );
          })}

          {timeTicks.map(({ x, label }) => (
            <React.Fragment key={label || '0'}>
              <Line
                x1={x} y1={totalH - 4} x2={x} y2={totalH}
                stroke={CLR.timeTick} strokeWidth={1}
              />
              {label !== '' && (
                <SvgText
                  x={x} y={totalH + 13}
                  fill={CLR.axisText} fontSize={9} textAnchor="middle"
                >
                  {label}
                </SvgText>
              )}
            </React.Fragment>
          ))}

          {(!isConnected || nChannels === 0) && (
            <SvgText
              x={chartWidth / 2} y={totalH / 2 + 6}
              fill={CLR.noSignal} fontSize={14} fontWeight="600" textAnchor="middle"
            >
              {nChannels === 0 ? 'No channels selected' : 'Waiting for signal…'}
            </SvgText>
          )}
        </Svg>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems   : 'flex-start',
  },
  labelCol: {
    width   : LABEL_WIDTH,
    position: 'relative',
  },
  labelCell: {
    position      : 'absolute',
    left          : 0,
    width         : LABEL_WIDTH,
    justifyContent: 'center',
    alignItems    : 'flex-end',
    paddingRight  : 4,
  },
  chLabel: {
    fontSize  : 9,
    fontFamily: MONO,
    fontWeight: '600',
  },
});

export default MultiChannelChart;
