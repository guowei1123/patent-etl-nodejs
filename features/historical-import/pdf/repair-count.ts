/** Refuse replacement when the PDF extraction does not match the stored drawing count. */
export function validateDrawingCount(oldCount:number, extractedCount:number):void {
  if(oldCount!==extractedCount) {
    throw new Error(`说明书附图数量不一致：数据库 ${oldCount} 张，PDF 提取 ${extractedCount} 张；已停止替换，请人工核对`)
  }
}
