export interface ScheduleEvent {
  id: string;
  title: string;
  /** 日期，格式 YYYY-MM-DD */
  date: string;
  /** 开始时间，自当天 00:00 起的分钟数 */
  startMin: number;
  /** 结束时间，自当天 00:00 起的分钟数 */
  endMin: number;
  kind: "course" | "task" | "event";
  location?: string;
  remindBeforeMin?: number;
  goalId?: string;
  /** 导入批次标识，同一批（一门课 × 多周实例）共享一个 groupId，便于整批删除。 */
  groupId?: string;
  unverified?: boolean;
}

export interface Goal {
  id: string;
  level: "year" | "month" | "week";
  title: string;
  /** 所属周期，如 "2026" / "2026-11" / "2026-11-10" */
  period: string;
  parentId?: string;
  done?: boolean;
  /** 截止日期 YYYY-MM-DD */
  deadline?: string;
  /** 每周投入小时数 */
  hoursPerWeek?: number;
  /** 优先级 */
  priority?: "高" | "中" | "低";
}

export interface KnowledgePoint {
  id: string;
  /** 具体知识点，如「洛必达法则」 */
  name: string;
  /** 所属章节，如「导数应用」；没有就空字符串 */
  category: string;
  difficulty: "基础" | "进阶" | "难点";
  /** 学习该知识点预估分钟数，30..240 */
  estimatedMinutes: number;
  /** 学习顺序，从 1 开始 */
  order: number;
  /** 预留：后续做覆盖率追踪 */
  mastered?: boolean;
}
