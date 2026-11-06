import type pg from 'pg'
import { appendFile, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import type { ImportConfig, ImportRecord } from './model.ts'
import { applicationKey } from './identity.ts'

// Lookup in bounded chunks by complete publication number; do not load the patent table into memory.
export async function snapshotRequested(
  pool: pg.Pool,
  directory: string,
  config: ImportConfig,
) {
  if (!['text', 'images'].includes(config.stage))
    throw new Error('本阶段不需要公开号匹配')
  const target = path.join(directory, 'database-records.jsonl')
  const errors = path.join(directory, 'database-errors.jsonl')
  await writeFile(target, '')
  await writeFile(errors, '')
  const requested = createInterface({
    input: createReadStream(path.join(directory, 'requested.jsonl'), 'utf8'),
    crlfDelay: Infinity,
  })
  let chunk: string[] = []
  async function flush() {
    if (!chunk.length) return
    const result = await pool.query<ImportRecord & { id: string }>(
      `SELECT p.id,
      'CN' || regexp_replace(regexp_replace(upper(p.doc_number),'^CN',''),'[ABCUY][0-9]?$','') || p.kind AS publication,
      COALESCE(p.app_number,'') AS application,
      p.kind,COALESCE(p.pub_date,'') AS date,COALESCE(p.title,'') AS title,COALESCE(p.abstract,'') AS abstract,
      COALESCE(p.grant_number,'') AS grant,COALESCE(p.grant_date,'')::text AS "grantDate"
      FROM cnipa.patent p WHERE p.kind ~ '^[ABCUY][0-9]?$'
      AND p.doc_number=ANY($1::text[])
      AND COALESCE(p.pub_country,'CN')='CN'`,
      [
        chunk.flatMap((number) => {
          const digits = number.replace(/^CN/, '').replace(/[ABCUY]\d?$/, '')
          return [digits, `CN${digits}`, number]
        }),
      ],
    )
    const rows = new Map<string, Array<ImportRecord & { id: string }>>()
    for (const row of result.rows)
      rows.set(row.publication, [...(rows.get(row.publication) || []), row])
    for (const publication of chunk) {
      const matches = rows.get(publication) || []
      if (matches.length > 1) {
        await appendFile(
          errors,
          JSON.stringify({
            publication,
            error: '数据库存在重复公开号，请核对冲突记录后重试',
          }) + '\n',
        )
        continue
      }
      const row = matches[0]
      let application = ''
      if (row?.application) {
        try {
          application = `CN${applicationKey(row.application)}`
        } catch {
          /* Wait for valid metadata. */
        }
      }
      await appendFile(
        target,
        JSON.stringify({
          ...row,
          publication,
          kind: publication.match(/[ABCUY]\d?$/)![0],
          application,
          date: row?.date || '',
          title: row?.title || '',
          abstract: row?.abstract || '',
          grant: row?.grant || '',
          grantDate: row?.grantDate || '',
          description: '',
          claims: '',
          applicant: '',
          inventor: '',
          ipc: '',
          raw: {},
          source: row ? `database:${row.id}` : `publication:${publication}`,
          metadataPending: !application || !row?.date || !row?.title,
          status: 'ready',
          reasons: [],
        }) + '\n',
      )
    }
    chunk = []
  }
  for await (const line of requested) {
    chunk.push(JSON.parse(line))
    if (chunk.length >= 250) await flush()
  }
  await flush()
}
