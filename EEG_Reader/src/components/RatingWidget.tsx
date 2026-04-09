import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface RatingWidgetProps {
  alarmId : string;
  current : number | null;
  onRate  : (alarmId: string, rating: number) => void;
}

export default function RatingWidget({ alarmId, current, onRate }: RatingWidgetProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const display = hovered ?? current;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Was this alarm accurate?</Text>
      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map(n => (
          <TouchableOpacity
            key={n}
            onPress={() => onRate(alarmId, n)}
            onPressIn={() => setHovered(n)}
            onPressOut={() => setHovered(null)}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          >
            <Text style={[
              styles.star,
              display !== null && n <= display && styles.starActive,
            ]}>
              ★
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {current !== null && (
        <Text style={styles.rated}>Rated {current}/5 — thank you</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap       : 8,
    marginTop : 12,
  },
  label: {
    color    : '#8899AA',
    fontSize : 13,
  },
  stars: {
    flexDirection: 'row',
    gap          : 8,
  },
  star: {
    fontSize: 30,
    color   : '#1E2E44',
  },
  starActive: {
    color: '#FFCC00',
  },
  rated: {
    color    : '#445566',
    fontSize : 12,
  },
});
