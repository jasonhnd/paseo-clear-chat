import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import ja from "./locales/ja.json";

export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN, ja } });
