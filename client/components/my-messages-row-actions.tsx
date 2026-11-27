import { Pressable, Text, View, type TextStyle } from "react-native";

interface RowActionsProps {
  copyLabel: string;
  quoteLabel: string;
  onCopy: () => void;
  onQuote: () => void;
  labelStyle: TextStyle;
  borderColor: string;
}

// Keep these controls outside the row's Pressable so neither can activate it.
export function MyMessagesRowActions({ copyLabel, quoteLabel, onCopy, onQuote, labelStyle, borderColor }: RowActionsProps) {
  const button = { minHeight: 36, justifyContent: "center" as const, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 }}>
      <Pressable testID="my-message-copy" accessibilityRole="button" accessibilityLabel={copyLabel} style={button} onPress={onCopy}>
        <Text style={labelStyle}>{copyLabel}</Text>
      </Pressable>
      <Pressable testID="my-message-quote" accessibilityRole="button" accessibilityLabel={quoteLabel} style={button} onPress={onQuote}>
        <Text style={labelStyle}>{quoteLabel}</Text>
      </Pressable>
    </View>
  );
}
