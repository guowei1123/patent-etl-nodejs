import type pg from 'pg'
import { encodeRepairJpeg } from './repair-jpeg.ts'

type Encoded = Awaited<ReturnType<typeof encodeRepairJpeg>>

/** Perform CPU-heavy work before acquiring transaction locks. */
export async function prepareDrawingJpegs(images:Buffer[], encode=encodeRepairJpeg) {
  const results:Array<{jpeg?:Encoded;error?:unknown}>=[]
  for(const image of images) {
    try {results.push({jpeg:await encode(image)})}
    catch(error) {results.push({error})}
  }
  return results
}

/** Checked-out pg clients emit errors while no query is pending. */
export function monitorRepairConnection(client:pg.PoolClient) {
  let failure:Error|undefined
  const onError=(error:Error)=>{failure=error}
  client.on('error',onError)
  return {
    assert() {if(failure) throw failure},
    release() {client.removeListener('error',onError);client.release(failure)},
  }
}
