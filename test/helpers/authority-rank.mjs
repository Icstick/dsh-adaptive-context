// test/helpers/authority-rank.mjs — 秩表的**独立第二推导**（用于交叉校验 AUTHORITY_RANK）
//
// 为什么不在测试里手抄一份：手抄两边一起抄错是常见事故。这里从另一条**不依赖 policy.mjs**
// 的既有事实推出来：
//   ① src/constants.mjs 的 AUTHORITY_ORDER 是「枚举/声明顺序」，不是权威序
//      （system_policy 排第一，若当权威序会得出「系统策略 > 用户明说」这一与
//       test/observation-authority.test.mjs 注释相反的错误结论）——所以不能拿它当序。
//   ② 权威序在仓库里唯一被断言过的地方是 test/observation-authority.test.mjs:
//      「秩序（高→低）：user_correction > user_explicit > system_policy > external_information
//        > single_observation > agent_inference > agent_self_evaluation」
//   ③ src/store.mjs 的 deriveObservationAuthority 的 rank 表给出同一组数值。
// 本文件把 ② 的文字序写成数值，用来对照 ③ 落进 policy.mjs 的 AUTHORITY_RANK。
export const DECLARED_AUTHORITY_RANK = Object.freeze({
  user_correction: 6,
  user_explicit: 5,
  system_policy: 4,
  external_information: 3,
  single_observation: 2,
  agent_inference: 1,
  agent_self_evaluation: 0,
})
