import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '../navigation/NavigationContext';
import type { Screen } from '../navigation/types';
import type { UserRole } from '../services/supabaseClient';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

interface TabDef {
  screen: Screen;
  icon  : string;
  label : string;
}

const TABS_BY_ROLE: Record<UserRole, TabDef[]> = {
  patient: [
    { screen: 'community', icon: '⌂', label: 'Community' },
    { screen: 'tracker',   icon: '◎', label: 'Tracker'   },
    { screen: 'archive',   icon: '☰', label: 'Archive'   },
    { screen: 'settings',  icon: '⚙', label: 'Settings'  },
  ],
  helper: [
    { screen: 'community', icon: '⌂', label: 'Community' },
    { screen: 'archive',   icon: '☰', label: 'Archive'   },
    { screen: 'settings',  icon: '⚙', label: 'Settings'  },
  ],
  doctor: [
    { screen: 'community', icon: '⌂', label: 'Community' },
    { screen: 'settings',  icon: '⚙', label: 'Settings'  },
  ],
  supporter: [
    { screen: 'community', icon: '⌂', label: 'Community' },
    { screen: 'settings',  icon: '⚙', label: 'Settings'  },
  ],
};

interface BottomTabBarProps {
  activeTab    : Screen;
  role         : UserRole;
  isTracking  ?: boolean;
}

export default function BottomTabBar({ activeTab, role, isTracking = false }: BottomTabBarProps) {
  const { navigate } = useNavigation();
  const insets       = useSafeAreaInsets();
  const tabs         = TABS_BY_ROLE[role] ?? TABS_BY_ROLE.supporter;

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom || 8 }]}>
      {tabs.map((tab, i) => {
        const isActive = activeTab === tab.screen;
        return (
          <React.Fragment key={tab.screen}>
            {i > 0 && <View style={styles.divider} />}
            <TouchableOpacity
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => navigate(tab.screen)}
              activeOpacity={0.7}
            >
              <View style={styles.iconRow}>
                <Text style={[styles.tabIcon, isActive && styles.tabIconActive]}>
                  {tab.icon}
                </Text>
                {tab.screen === 'tracker' && isTracking && (
                  <View style={styles.pulsingDot} />
                )}
              </View>
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          </React.Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection    : 'row',
    alignItems       : 'center',
    backgroundColor  : '#0A1018',
    borderTopWidth   : 1,
    borderTopColor   : '#0D1828',
    paddingTop       : 8,
    paddingHorizontal: 12,
  },
  tab: {
    flex          : 1,
    alignItems    : 'center',
    gap           : 3,
    paddingVertical: 4,
  },
  tabActive: {},
  iconRow: {
    flexDirection: 'row',
    alignItems   : 'center',
    gap          : 4,
  },
  tabIcon: {
    fontSize: 18,
    color   : '#2A3A50',
  },
  tabIconActive: {
    color: '#00FF88',
  },
  tabLabel: {
    fontSize     : 10,
    fontFamily   : MONO,
    fontWeight   : '600',
    color        : '#2A3A50',
    letterSpacing: 0.5,
  },
  tabLabelActive: {
    color: '#00FF88',
  },
  divider: {
    width          : 1,
    height         : 28,
    backgroundColor: '#0D1828',
    marginHorizontal: 2,
  },
  pulsingDot: {
    width          : 6,
    height         : 6,
    borderRadius   : 3,
    backgroundColor: '#00FF88',
  },
});
