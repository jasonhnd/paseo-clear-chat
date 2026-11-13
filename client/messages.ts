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
  turnHeadChanged: "Git HEAD changed during this period; the status difference may be incomplete.",
  turnInterrupted: "The turn ended before it completed; the observed change set may be incomplete.",
  turnNotGit: "This workspace is not a Git repository; changes cannot be shown yet.",
  turnIncomplete: "Snapshot timing or overlap with other conversations may be incomplete.",
  turnOverlap: "Other conversations were running in this workspace during this period, so these changes may not all belong to this turn.",
  turnWindowTitle: "Workspace changes during this turn",
  turnRenamedFrom: "renamed from",
  turnRenamedTo: "renamed to",
  turnBinaryFile: "binary file",
  turnNoTextDiff: "no textual diff in Git",
  turnUntrackedNoTextDiff: "untracked or no textual diff in Git",
  turnNoDiffAvailable: "no diff available from Git",
  turnNoTextualDiffShort: "no textual diff",
  turnDiffTruncated: "diff truncated",
  turnOutputCutAtSizeLimit: "output cut at the size limit",
  turnDiffOmittedFileLimit: "diff omitted (file limit)",
  turnDiffOmittedTotalLimit: "diff omitted (total size limit)",
  running: "Running now", runningPill: "Running", runningFor: "Running for {n} min", finished: "Finished today", noProjects: "No projects yet.",
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
  turnHeadChanged: "这段时间里 Git HEAD 变了，所以状态差异可能不完整。",
  turnInterrupted: "这一轮没有跑完就结束了，看到的改动可能不完整。",
  turnNotGit: "这个工作区不是 Git 仓库，暂时不能显示改动。",
  turnIncomplete: "快照的时间窗或与其他对话重叠，看到的改动可能不完整。",
  turnOverlap: "这段时间里同一个工作区还有别的对话在跑，这些改动不一定都属于这一轮。",
  turnWindowTitle: "这一轮的改动",
  turnRenamedFrom: "改名自",
  turnRenamedTo: "改名为",
  turnBinaryFile: "二进制文件",
  turnNoTextDiff: "Git 中没有文本差异",
  turnUntrackedNoTextDiff: "未跟踪，或 Git 中没有文本差异",
  turnNoDiffAvailable: "Git 中没有可显示的差异",
  turnNoTextualDiffShort: "没有文本差异",
  turnDiffTruncated: "差异已截断",
  turnOutputCutAtSizeLimit: "输出已按大小上限截断",
  turnDiffOmittedFileLimit: "差异已省略（文件数量上限）",
  turnDiffOmittedTotalLimit: "差异已省略（总大小上限）",
  running: "正在运行", runningPill: "跑着", runningFor: "已跑 {n} 分钟", finished: "今天完成", noProjects: "暂无项目。",
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
