import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:\\Users\\Administrator\\.dsh\\acp\\acp-ledger.db')
const args = process.argv.slice(2)
const apply = args.includes('--apply')

const KEEP = new Set(['3eda2d','e57a26','e2dcf7','656656','84aeba','a2b912','44d86a','4985d4','1fab13','73c8a6','53142b','0a529c','d10298'])
const FLOW = ['询问','确认','同意','审批','批准','回复','回应','回答','告知','反馈','报告','表示','告诉','提及','使用','委托','请求','选择','采用','处于','从事','知晓','知道','指示','问候','重启','暂停','继续','进行','完成','开始','测试','验证','检查','查看','搜索','拉取','关闭','遇到','提供','收集','关注','计划','拍板','directed','agreed','asked','reported','requested','prefers','replied','confirmed','需提供','修改了','给出了','已完成','已回复','验证了','使用了','进行过','使用过','拍板了']
const rows = db.prepare(`SELECT id, subject, predicate, substr(text,1,52) AS t FROM observation
  WHERE state='active' AND subject IN ('用户','User','user') AND authority='user_explicit'`).all()
const hits = []
for (const r of rows) {
  const p = r.predicate ?? ''
  if (KEEP.has(r.id.slice(-6))) continue
  if (FLOW.some(f => p.includes(f))) hits.push(r)
}
console.log('治理候选:', hits.length, '（保留画像', rows.length - hits.length, '条）')
for (const h of hits) console.log(h.id.slice(-6), '|', h.predicate, '|', h.t)
if (apply && hits.length > 0) {
  const now = Date.now()
  const upd = db.prepare(`UPDATE observation SET state='superseded' WHERE id=?`)
  const ins = db.prepare(`INSERT INTO audit (ts, op, target_id, scope_id, actor, reason, payload) VALUES (?,?,?,?,?,?,?)`)
  db.exec('BEGIN')
  for (const h of hits) {
    upd.run(h.id)
    ins.run(now, 'supersede_transient_observation', h.id, 'user-global',
      't25-cleanup-20260907', 'action-flow transcript superseded (T2.5)',
      JSON.stringify({ subject: h.subject, predicate: h.predicate }))
  }
  db.exec('COMMIT')
  console.log('applied:', hits.length)
}
db.close()
