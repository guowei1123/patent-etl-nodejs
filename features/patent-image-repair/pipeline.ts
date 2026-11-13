/** Limit in-flight patents while starting each update as soon as its extraction is ready. */
export async function runPipeline<T>(source:AsyncIterable<T>, concurrency:number, stopped:()=>boolean, work:(item:T)=>Promise<void>) {
  const active=new Set<Promise<void>>()
  let failure:unknown
  for await(const item of source) {
    if(stopped() || failure) break
    while(active.size>=concurrency) await Promise.race(active)
    if(stopped() || failure) break
    const job:Promise<void>=work(item).catch(error=>{failure=error}).finally(()=>{active.delete(job)})
    active.add(job)
  }
  await Promise.all(active)
  if(failure) throw failure
}

export function serialQueue() {
  let tail:Promise<unknown>=Promise.resolve()
  return function run<T>(work:()=>Promise<T>):Promise<T> {
    const result=tail.then(work,work)
    tail=result.catch(()=>{})
    return result
  }
}
