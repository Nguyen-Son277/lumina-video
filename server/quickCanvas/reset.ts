import type { Database } from '../db/index'
import type { CanvasNode } from '../../shared/canvas'

import { badRequest, conflict } from '../lib/errors'
import { readQuickCanvas, writeQuickCanvas } from './service'

/** Explicitly restore imported source content while retaining group geometry. */
export function resetQuickGroup(db:Database,userId:string,sessionId:string,groupId:string,baseRevision:number) {
  const savepoint='quick_canvas_reset'
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    const result=(()=>{
    const canvas=readQuickCanvas(db,userId,sessionId)
    if(canvas.revision!==baseRevision)throw conflict('Bảng Canvas đã được lưu ở nơi khác',{messageKey:'canvas.revision_conflict'})
    if(!canvas.graph.groups?.some(group=>group.id===groupId))throw badRequest('Không tìm thấy nhóm nhập từ phiên')
    const rows=db.prepare('SELECT source_key,snapshot_json FROM quick_canvas_sources WHERE session_id=?').all(sessionId) as Array<{source_key:string;snapshot_json:string}>
    const imported=rows.map(row=>({...row,node:JSON.parse(row.snapshot_json) as CanvasNode})).filter(row=>row.node.groupId===groupId)
    if(!imported.length)throw badRequest('Nhóm này không có nguồn phiên để đặt lại')
    for(const {source_key,node} of imported) {
      const index=canvas.graph.nodes.findIndex(local=>local.id===node.id)
      if(index>=0)canvas.graph.nodes[index]={...node,data:{...node.data,...(canvas.graph.nodes[index]!.data.selectedRunId?{selectedRunId:canvas.graph.nodes[index]!.data.selectedRunId}:{})},x:canvas.graph.nodes[index]!.x,y:canvas.graph.nodes[index]!.y}
      else canvas.graph.nodes.push(node)
      db.prepare("UPDATE quick_canvas_sources SET tombstoned=0,conflicts_json='[]' WHERE session_id=? AND source_key=?").run(sessionId,source_key)
    }
    const prompt=imported.find(row=>row.node.kind==='prompt')?.node
    const target=imported.find(row=>row.node.kind==='image'||row.node.kind==='video')?.node
    if(target)for(const {node:source} of imported) {
      if(source.id===target.id)continue
      const targetPort=source.kind==='prompt'?'prompt':source.kind==='library'||source.kind==='character'?'context':['upload','image','sheet'].includes(source.kind)?'image':undefined
      if(!targetPort||canvas.graph.edges.some(edge=>edge.source===source.id&&edge.target===target.id&&edge.targetPort===targetPort))continue
      canvas.graph.edges.push({id:`${groupId}:reset:${source.id}`,source:source.id,sourcePort:targetPort==='context'?'object':targetPort,target:target.id,targetPort})
    }
    return {graph:canvas.graph,baseRevision}
    })()
    const canvas=writeQuickCanvas(db,userId,sessionId,result)
    db.exec(`RELEASE ${savepoint}`)
    return canvas
  } catch(error) {
    try{db.exec(`ROLLBACK TO ${savepoint}`);db.exec(`RELEASE ${savepoint}`)}catch{/* Writer already owns its rollback. */}
    throw error
  }
}
