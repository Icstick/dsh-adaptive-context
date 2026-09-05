/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖 = 设计坏味：被依赖方不得反向依赖依赖方',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-src-to-test',
      severity: 'error',
      comment: '运行时代码不得依赖测试代码',
      from: { path: '^src' },
      to: { path: '^(test|test/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|lib/client\.js|\.git)' },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
