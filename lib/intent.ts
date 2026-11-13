/** 判断用户一句话是「安排事件」还是「设定目标」。 */

export type Intent = "schedule" | "goal";

/** 明确的星期/日期锚点：周X、星期X、今天/明天/后天/大后天、下周。 */
const DAY_PATTERN = /(周|星期)[一二三四五六日天]|今天|明天|后天|大后天|下周/;

/** 具体时段：数字+点/时/：，或上午/下午/晚上/中午/早上。 */
const TIME_OF_DAY_PATTERN = /\d+[点时：:]|上午|下午|晚上|中午|早上/;

/** 目标型词汇：表达「想达成什么」而非「某个时间点做某事」。 */
const GOAL_PATTERN =
  /我要|我想|准备|考到|考上|学会|学完|目标|期末|期中|考试|一个月|一周内|每天|每周|提升|补|复习计划|想学/;

export function detectIntent(text: string): Intent {
  // 1) 明确时间点：星期/日期 + 时段或数字时间 -> 直接安排事件。
  if (DAY_PATTERN.test(text) && TIME_OF_DAY_PATTERN.test(text)) {
    return "schedule";
  }

  // 2) 目标型词汇且没有明确时间点 -> 目标。
  if (GOAL_PATTERN.test(text)) {
    return "goal";
  }

  // 3) 其余默认 goal：宁可多问一句，也不要乱加事件。
  return "goal";
}
