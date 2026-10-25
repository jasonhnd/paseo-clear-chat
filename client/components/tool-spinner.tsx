import { useTranslation } from "@getpaseo/plugin/client";
import { messages } from "../messages";
import React, { useEffect, useRef } from "react";
import { Animated, Easing, Platform } from "react-native";
import { Glyph } from "./glyph";

export function ToolSpinner({ color, size = 13 }: { color: string; size?: number }) {
  const { t } = useTranslation(messages);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.loop(Animated.timing(progress, {
      toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: Platform.OS !== "web",
    }));
    animation.start();
    return () => animation.stop();
  }, [progress]);
  return (
    <Animated.View accessibilityLabel={t("tool.spinnerA11y")} style={{ transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }}>
      <Glyph name="LoaderCircle" size={size} color={color} />
    </Animated.View>
  );
}
