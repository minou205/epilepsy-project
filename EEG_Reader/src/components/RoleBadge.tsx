import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const ROLE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  patient  : { bg: '#0A2A15', text: '#00FF88', border: '#00FF8840' },
  helper   : { bg: '#1A1A00', text: '#FFCC00', border: '#FFCC0040' },
  doctor   : { bg: '#0A1828', text: '#4499FF', border: '#4499FF40' },
  supporter: { bg: '#1A0A1A', text: '#CC44FF', border: '#CC44FF40' },
};

interface RoleBadgeProps {
  role: string;
  size?: 'small' | 'medium';
}

export default function RoleBadge({ role, size = 'small' }: RoleBadgeProps) {
  const colors = ROLE_COLORS[role] ?? ROLE_COLORS.supporter;
  const isSmall = size === 'small';

  return (
    <View style={[
      styles.badge,
      {
        backgroundColor: colors.bg,
        borderColor    : colors.border,
        paddingHorizontal: isSmall ? 6 : 10,
        paddingVertical  : isSmall ? 2 : 4,
      },
    ]}>
      <Text style={[
        styles.text,
        {
          color   : colors.text,
          fontSize: isSmall ? 9 : 11,
        },
      ]}>
        {role.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 6,
    borderWidth : 1,
    alignSelf   : 'flex-start',
  },
  text: {
    fontWeight   : '700',
    fontFamily   : MONO,
    letterSpacing: 0.5,
  },
});
