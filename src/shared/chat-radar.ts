export type ChatGroupTier = "core" | "voyage" | "regional";

export type ChatDigestCategory = "工具渠道" | "实操排坑" | "导师点评" | "变现思路";

export const CHAT_DIGEST_CATEGORIES: readonly ChatDigestCategory[] = [
  "工具渠道",
  "实操排坑",
  "导师点评",
  "变现思路",
] as const;

export type ChatGroupItem = {
  groupKey: string;
  platform: number;
  name: string;
  tier: ChatGroupTier;
  enabled: boolean;
  linkedActivityId: string | null;
  linkedBookTitle: string | null;
  messageCount: number;
  validMessageCount: number;
  digestCount: number;
  lastMsgTime: number;
  lastSyncedAt: string | null;
  lastDistilledMsgTime: number;
};

export type ChatMessageItem = {
  groupKey: string;
  groupName: string;
  tier: ChatGroupTier;
  linkedActivityId: string | null;
  msgId: string;
  msgTime: number;
  msgType: number;
  senderName: string;
  content: string;
  isNoise: boolean;
};

export type ChatDigestItem = {
  id: number;
  groupKey: string;
  groupName: string;
  linkedActivityId: string | null;
  linkedBookTitle: string | null;
  category: ChatDigestCategory;
  title: string;
  summary: string;
  keySpeakers: string[];
  msgTimeFrom: number;
  msgTimeTo: number;
  model: string;
  createdAt: string;
};

export type ChatRadarStats = {
  totalGroups: number;
  enabledGroups: number;
  coreGroups: number;
  voyageGroups: number;
  regionalGroups: number;
  totalMessages: number;
  validMessages: number;
  totalDigests: number;
  defaultDistillModel: string;
};

export type ChatGroupsResponse = {
  stats: ChatRadarStats;
  groups: ChatGroupItem[];
};

export type ChatMessagesSearchResponse = {
  total: number;
  limit: number;
  offset: number;
  items: ChatMessageItem[];
};

export type ChatMessageContextResponse = {
  groupKey: string;
  groupName: string;
  linkedActivityId: string | null;
  anchorMsgTime: number;
  items: ChatMessageItem[];
};

export type ChatDigestsResponse = {
  items: ChatDigestItem[];
  defaultModel: string;
};
