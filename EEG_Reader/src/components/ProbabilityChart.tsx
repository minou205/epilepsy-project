import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Dimensions, Platform } from 'react-native';
import Svg, { Path, Line, Rect, Text as SvgText } from 'react-native-svg';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

interface ProbabilityChartProps {
  title        : string;       // "Prediction" | "Detection"
  data         : number[];     // rolling probability values (0-1)
  threshold    : number;       // calibration threshold line
  color        : string;       // '#FFCC00' (prediction) | '#FF4444' (detection)
  maxPoints   ?: number;       // default 60 (5 min at 5s intervals)
  intervalSecs?: number;       // default 5
  height      ?: number;       // default 120
}

export default function ProbabilityChart({
  title,
  data,
  threshold    = 0.5,
  color,
  maxPoints    = 60,
  intervalSecs = 5,
  height       = 120,
}: ProbabilityChartProps) {
  const screenWidth = Dimensions.get('window').width;
  const MARGIN_H    = 12;  // horizontal margin on each side
  const Y_AXIS_W    = 28;  // space for Y-axis labels inside SVG
  const svgWidth    = screenWidth - MARGIN_H * 2;
  const chartWidth  = svgWidth - Y_AXIS_W - 4; // plotting area
  const chartHeight = height;

  const linePath = useMemo(() => {
    if (data.length === 0) return '';
    const xStep = chartWidth / Math.max(maxPoints - 1, 1);
    const offset = Math.max(0, maxPoints - data.length);
    const parts: string[] = [];

    for (let i = 0; i < data.length; i++) {
      const x = Y_AXIS_W + (offset + i) * xStep;
      const y = chartHeight - (Math.min(1, Math.max(0, data[i])) * chartHeight);
      parts.push(i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return parts.join('');
  }, [data, chartWidth, chartHeight, maxPoints]);

  const thresholdY = chartHeight - (threshold * chartHeight);

  // Time labels: show every ~1min
  const timeLabels = useMemo(() => {
    const labels: { x: number; label: string }[] = [];
    const totalSecs = maxPoints * intervalSecs;
    const stepSecs  = 60;
    const xStep     = chartWidth / Math.max(maxPoints - 1, 1);

    for (let s = 0; s <= totalSecs; s += stepSecs) {
      const pointIdx = s / intervalSecs;
      const x = Y_AXIS_W + pointIdx * xStep;
      const ago = totalSecs - s;
      labels.push({
        x,
        label: ago === 0 ? 'now' : `-${Math.floor(ago / 60)}m`,
      });
    }
    return labels;
  }, [chartWidth, maxPoints, intervalSecs]);

  // Y-axis labels
  const yLabels = [
    { y: 0, label: '1.0' },
    { y: chartHeight * 0.5, label: '0.5' },
    { y: chartHeight, label: '0.0' },
  ];

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color }]}>{title}</Text>
      <Svg width={svgWidth} height={chartHeight + 20}>
        {/* Background for chart area */}
        <Rect x={Y_AXIS_W} y={0} width={chartWidth} height={chartHeight} fill="#0A0A18" rx={4} />

        {/* Danger zone above threshold */}
        <Rect
          x={Y_AXIS_W} y={0}
          width={chartWidth} height={thresholdY}
          fill={color + '08'}
        />

        {/* Threshold line (dashed) */}
        <Line
          x1={Y_AXIS_W} y1={thresholdY}
          x2={Y_AXIS_W + chartWidth} y2={thresholdY}
          stroke={color + '66'}
          strokeWidth={1}
          strokeDasharray="6,4"
        />

        {/* Probability line */}
        {linePath !== '' && (
          <Path
            d={linePath}
            stroke={color}
            strokeWidth={2}
            fill="none"
          />
        )}

        {/* Y-axis labels */}
        {yLabels.map(({ y, label }) => (
          <SvgText
            key={label}
            x={2} y={y + 4}
            fill="#445566" fontSize={9}
          >
            {label}
          </SvgText>
        ))}

        {/* X-axis labels */}
        {timeLabels.map(({ x, label }) => (
          <SvgText
            key={label}
            x={x} y={chartHeight + 14}
            fill="#445566" fontSize={8} textAnchor="middle"
          >
            {label}
          </SvgText>
        ))}

        {/* No data message */}
        {data.length === 0 && (
          <SvgText
            x={Y_AXIS_W + chartWidth / 2} y={chartHeight / 2 + 4}
            fill="#334455" fontSize={12} textAnchor="middle"
          >
            Waiting for data...
          </SvgText>
        )}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical  : 6,
    gap              : 4,
  },
  title: {
    fontSize     : 11,
    fontWeight   : '700',
    fontFamily   : MONO,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingLeft  : 4,
  },
});
