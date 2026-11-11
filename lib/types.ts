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
