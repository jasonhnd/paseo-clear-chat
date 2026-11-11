import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import ja from "./locales/ja.json";

const sidebarEn = {
  title: "Clear Chat", description: "Agents grouped by project",
  today: "Today", waiting: "Answers waiting", directory: "Outline",
  waitingEmpty: "Nothing waiting for your answer.", directoryEmpty: "Nothing to show in the directory.",
  running: "Running now", finished: "Finished today", noProjects: "No projects yet.",
  noTodayActivity: "No activity today in this project.", unknownTime: "Time unknown",
  status: { initializing: "Initializing", idle: "Idle", running: "Running", error: "Error", closed: "Closed" },
};
const sidebarZhCN = {
  title: "Clear Chat", description: "按项目分组的智能体",
  today: "今天", waiting: "等你回答", directory: "目录",
  waitingEmpty: "还没有等待你回答的内容。", directoryEmpty: "目录中还没有可显示的内容。",
  running: "正在运行", finished: "今天完成", noProjects: "暂无项目。",
  noTodayActivity: "此项目今天没有活动。", unknownTime: "时间未知",
  status: { initializing: "启动中", idle: "空闲", running: "运行中", error: "出错", closed: "已关闭" },
};

export const messages = defineTranslations({
  resources: { en: { ...en, sidebar: sidebarEn }, "zh-CN": { ...zhCN, sidebar: sidebarZhCN }, ja },
});
