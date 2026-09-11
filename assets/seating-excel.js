(function(){
  'use strict';
  let ticket=0,pending=null,loading=null;
  const el=id=>document.getElementById('seatingExcel'+id);
  const status=message=>{el('Status').textContent=message;};
  function busy(value){['Download','Upload','Apply'].forEach(id=>{el(id).disabled=value;});}
  async function libraries(){
    if(window.ExcelJS&&window.SeatingWorkbook)return;
    if(!loading)loading=(async()=>{
      try{
        if(!window.ExcelJS)await withLoadDeadline(loadScriptOnce('seatingExcelJs','./assets/vendor/exceljs-4.4.0.min.js'),15000);
        if(!window.SeatingWorkbook)await withLoadDeadline(loadScriptOnce('seatingWorkbookCore','./assets/seating-workbook.js?v=3'),15000);
      }catch(e){
        ['seatingExcelJs','seatingWorkbookCore'].forEach(id=>{const s=document.getElementById(id);if(s&&s.dataset.loaded!=='true')s.remove();});
        loading=null;throw new Error('엑셀 기능을 불러오지 못했습니다. 다시 눌러주세요.');
      }
    })();
    await loading;
  }
  function directory(){
    const people=new Map();
    seatingPlans.concat([seatingSnapshot()]).forEach(p=>SeatingWorkbook.allSeats(p).forEach(s=>people.set(s.memberId,{id:s.memberId,name:s.name,part:s.part})));
    seatingMembers.forEach(m=>people.set(m.id,m));
    return [...people.values()];
  }
  function cancel(){ticket++;pending=null;busy(false);}
  function open(){
    if(!canUseSeatingPlan())return;
    cancel();el('Preview').hidden=true;status('');openModal('modalSeatingExcel');
  }
  async function download(){
    if(!canUseSeatingPlan())return;
    const turn=++ticket,snapshot=seatingSnapshot();pending=null;el('Preview').hidden=true;busy(true);status('엑셀을 만드는 중입니다.');
    try{
      await libraries();
      if(turn!==ticket||!canUseSeatingPlan())return;
      const workbook=SeatingWorkbook.build(ExcelJS,snapshot,directory());
      const bytes=await workbook.xlsx.writeBuffer();
      if(turn!==ticket||!canUseSeatingPlan())return;
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const a=document.createElement('a');a.href=url;a.download=((snapshot.planName||'자리배치')+'.xlsx').replace(/[\\/:*?"<>|]/g,'_');
      document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
      status('엑셀 파일을 내려받았습니다.');
    }catch(e){if(turn===ticket)status(e.message||'엑셀을 만들지 못했습니다.');}
    finally{if(turn===ticket)busy(false);}
  }
  function positions(plan){
    const map=new Map();
    [['rows','합창'],['orchestraRows','관현악']].forEach(([field,label])=>(plan[field]||[]).forEach(r=>r.seats.forEach((s,i)=>{if(s)map.set(s.memberId,{name:s.name,place:label+' '+r.label+' '+(i+1)+'번'});})));
    const special=plan.specialSlots||{};
    [['conductor','지휘'],['accompanist','반주']].forEach(([k,label])=>{const s=special[k];if(s)map.set(s.memberId,{name:s.name,place:label});});
    (special.staff||[]).forEach((s,i)=>{if(s)map.set(s.memberId,{name:s.name,place:'스태프 '+(i+1)});});
    return map;
  }
  async function read(file){
    if(!file||!canUseSeatingPlan())return;
    const turn=++ticket;pending=null;el('Preview').hidden=true;
    if(!/\.xlsx$/i.test(file.name)||file.size>2*1024*1024||file.size===0){status('2MB 이하의 자리배치 .xlsx 파일을 선택해주세요.');return;}
    const fingerprint=seatingSaveFingerprint(),epoch=seatingEditorEpoch;
    busy(true);status('이름과 자리를 확인하는 중입니다.');
    try{
      await libraries();
      const bytes=await file.arrayBuffer();
      const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);
      if(turn!==ticket||!canUseSeatingPlan())return;
      if(epoch!==seatingEditorEpoch||fingerprint!==seatingSaveFingerprint())throw new Error('현재 배치가 변경되었습니다. 파일을 다시 선택해주세요.');
      const result=SeatingWorkbook.parse(workbook,directory());
      el('Preview').hidden=false;el('Name').value=result.snapshot.planName;
      el('Apply').hidden=result.issues.length>0;
      const lines=[];
      if(result.issues.length){status('확인할 항목 '+result.issues.length+'개 · 아직 반영하지 않았습니다.');lines.push(...result.issues);}
      else{
        status(result.rows+'줄 · 배치 '+result.placed+'명 · 빈자리 '+result.empty+'칸');
        const before=positions(seatingSnapshot()),after=positions(result.snapshot);
        new Set([...before.keys(),...after.keys()]).forEach(id=>{
          const a=before.get(id),b=after.get(id);
          if(a?.place!==b?.place)lines.push((b||a).name+' · '+(a?.place||'미배치')+' → '+(b?.place||'미배치'));
        });
        if(!lines.length)lines.push('현재 배치와 자리 변경 없음');
        pending={result,fingerprint,epoch};
      }
      el('Changes').replaceChildren(...lines.map(line=>{const div=document.createElement('div');div.textContent=line;return div;}));
    }catch(e){if(turn===ticket)status(e.message||'엑셀을 읽지 못했습니다. 파일을 확인해주세요.');}
    finally{if(turn===ticket)busy(false);}
  }
  function apply(){
    if(!pending||!canUseSeatingPlan())return;
    if(pending.epoch!==seatingEditorEpoch||pending.fingerprint!==seatingSaveFingerprint()){pending=null;status('현재 배치가 변경되었습니다. 파일을 다시 선택해주세요.');el('Apply').hidden=true;return;}
    const name=el('Name').value.trim();if(!name)return status('새 배치 이름을 입력해주세요.');
    const snap=pending.result.snapshot;snap.planName=name;
    // Import is local and undoable. Saving a new ID cannot overwrite a publication.
    beginSeatingEdit();resetSeatingWorkspaceTransientState();applySeatingSnapshot(snap,true);
    closeModal('modalSeatingExcel');fitSeatingBoardInView();showToast('새 배치로 불러왔습니다. 확인 후 저장해주세요.');
  }
  window.SeatingExcel={open,cancel,download,read,apply};
})();
