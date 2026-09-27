import { Tabs } from 'expo-router';
import React from 'react';

import { FloatingNav } from '@/components/FloatingNav';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { usePushNotifications } from '@/hooks/usePushNotifications';

export default function TabLayout() {
  usePushNotifications(); // register device for new-signal push notifications

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
      }}
      // One floating nav button (with live P/L + Risk either side) that expands
      // into a menu of every screen, instead of a crowded row of tabs.
      tabBar={(props) => <FloatingNav {...props} />}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="positions"
        options={{
          title: 'Portfolio',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="list.bullet" color={color} />,
        }}
      />
      <Tabs.Screen
        name="signals"
        options={{
          title: 'Market Signals',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="antenna.radiowaves.left.and.right" color={color} />,
        }}
      />
      <Tabs.Screen
        name="scorecard"
        options={{
          title: 'Scorecard',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="chart.bar.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="news"
        options={{
          title: 'News',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="calendar" color={color} />,
        }}
      />
      <Tabs.Screen
        name="zones"
        options={{
          title: 'Zones',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="square.stack.3d.up" color={color} />,
        }}
      />
      <Tabs.Screen
        name="commands"
        options={{
          title: 'Trade Control',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="bolt.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          href: null,
        }}
      />
    </Tabs>
  );
}
