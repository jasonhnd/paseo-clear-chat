import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import ja from "./locales/ja.json";
import sidebarEnExtra from "./sidebar-locales/en.json";
import sidebarZhCNExtra from "./sidebar-locales/zh-CN.json";
import sidebarJaExtra from "./sidebar-locales/ja.json";

const sidebarEn = {
  ...sidebarEnExtra,
  title: "Clear Chat", description: "Agents grouped by project",
  today: "Today", waiting: "Answers waiting", directory: "Outline",
  search: "Search", searchPlaceholder: "Search loaded titles", searchEmpty: "No matching conversations.",
  searchLimit: "Only loaded titles and timeline text on the current host are searched. Unloaded history, archived conversations, and other providers are not included.",
  searchLimitOlder: "Only loaded titles and fetched timeline text on the current host are searched. Older pages were not fetched, so their text was not searched. Unloaded history, archived conversations, and other providers are not included.",
  waitingEmpty: "Nothing waiting for your answer.", errorsEmpty: "No conversations stopped with an error.", directoryEmpty: "Nothing to show in the directory.",
  running: "Running now", runningPill: "Running", runningFor: "Running for {n} min", finished: "Finished today", noProjects: "No projects yet.",
  finishedAt: "Finished {time}", finishedAtNote: "Observed locally; may be slightly late",
  noTodayActivity: "No activity today in this project.", unknownTime: "Time unknown",
  status: { initializing: "Initializing", idle: "Idle", running: "Running", error: "Error", closed: "Closed" },
};
const sidebarZhCN = {
  ...sidebarZhCNExtra,
  title: "Clear Chat", description: "按项目分组的智能体",
  today: "今天", waiting: "等你回答", directory: "目录",
  search: "搜索", searchPlaceholder: "搜索已加载的标题", searchEmpty: "没有匹配的对话。",
  searchLimit: "仅搜索当前主机上已加载的标题和时间线文本。不包括未加载的历史记录、已归档的对话和其他提供商。",
  searchLimitOlder: "仅搜索当前主机上已加载的标题和已获取的时间线文本。未获取较早的页面，因此未搜索其中的文本。不包括未加载的历史记录、已归档的对话和其他提供商。",
  waitingEmpty: "还没有等待你回答的内容。", errorsEmpty: "没有因错误停下的对话。", directoryEmpty: "目录中还没有可显示的内容。",
  running: "正在运行", runningPill: "跑着", runningFor: "已跑 {n} 分钟", finished: "今天完成", noProjects: "暂无项目。",
  finishedAt: "{time} 完成", finishedAtNote: "时间为本机观察，可能略晚",
  noTodayActivity: "此项目今天没有活动。", unknownTime: "时间未知",
  status: { initializing: "启动中", idle: "空闲", running: "运行中", error: "出错", closed: "已关闭" },
};


const sidebarJa = {
  ...sidebarJaExtra,
  title: "Clear Chat", description: "プロジェクト別のエージェント",
  today: "今日", waiting: "回答待ち", directory: "一覧",
  waitingEmpty: "回答待ちはありません。", directoryEmpty: "一覧に表示する内容はありません。",
  running: "実行中", runningPill: "実行中", runningFor: "{n}分経過", finished: "今日完了", noProjects: "プロジェクトはまだありません。",
  noTodayActivity: "このプロジェクトに今日の活動はありません。", unknownTime: "時刻不明",
  status: { initializing: "起動中", idle: "待機中", running: "実行中", error: "エラー", closed: "終了" },
};

export const messages = defineTranslations({
  resources: { en: { ...en, sidebar: sidebarEn }, "zh-CN": { ...zhCN, sidebar: sidebarZhCN }, ja: { ...ja, sidebar: sidebarJa } },
});
