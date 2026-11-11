import type { Goal } from "./types";

/** 目标在界面上显示为黄色小标签的标记。 */
export type GoalFlag = "未拆解" | "未归属";

/**
 * 嵌套校验（纯函数）：根据目标层级与全体目标的父子关系，返回该目标的标记。
 * - year：没有任何 month 子目标 → 「未拆解」
 * - month：没有 year 父目标 → 「未归属」
 * - week：没有 month 父目标 → 「未归属」
 */
export function getGoalFlags(goal: Goal, allGoals: Goal[]): GoalFlag[] {
  if (goal.level === "year") {
    const hasChild = allGoals.some((g) => g.level === "month" && g.parentId === goal.id);
    return hasChild ? [] : ["未拆解"];
  }
  if (goal.level === "month") {
    const hasParent = allGoals.some((g) => g.level === "year" && g.id === goal.parentId);
    return hasParent ? [] : ["未归属"];
  }
  // week
  const hasParent = allGoals.some((g) => g.level === "month" && g.id === goal.parentId);
  return hasParent ? [] : ["未归属"];
}
