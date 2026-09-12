(function(root){
  'use strict';
  const MAGIC='choir-seating-xlsx', VERSION=3, MAX_ROWS=40, MAX_COLS=120;
  const boards=[['합창 배치','rows'],['관현악 배치','orchestraRows']];
  const partStyles=[['S1','FFE3EAF8'],['S2','FFF8E2E4'],['T1','FFE5EEDC'],['T2','FFFFE7B5'],['관현악','FFECE5F4']];
  // One seat spans two half-seat columns; match the app's centered parity geometry.
  function boardGeometry(rows){
    const max=Math.max(...rows.map(r=>r.seats.length));
    let previousPhase=0;
    return rows.map((r,i)=>{
      const numbered=String(r.label).match(/^(\d+)\s*단$/);
      const phase=numbered?Number(numbered[1])%2:(i?1-previousPhase:(r.offset===.5?1:0));
      previousPhase=phase;
      const shift=phase===r.seats.length%2?0:1;
      return {row:4+i*2,start:3+max-r.seats.length+shift,count:r.seats.length,offset:phase/2};
    });
  }
  const key=value=>String(value||'').normalize('NFC').replace(/\s+/g,'').trim();
  const centerOffset=value=>Number.isSafeInteger(Number(value))?Number(value):0;
  const memberLabelKey=value=>key(String(value||'').normalize('NFKC')).replace(/\(([^()]*)\)$/,'[$1]').toLowerCase();
  const allSeats=plan=>[].concat(...(plan.rows||[]).map(r=>r.seats),...(plan.orchestraRows||[]).map(r=>r.seats),plan.specialSlots?.conductor,plan.specialSlots?.accompanist,plan.specialSlots?.staff||[]).filter(Boolean);
  function fail(message){throw new Error(message);}
  function text(cell){
    const v=cell.value;
    if(v==null)return '';
    if(typeof v==='string'||typeof v==='number')return String(v).trim();
    if(v.richText)return v.richText.map(x=>x.text).join('').trim();
    fail(cell.address+': 수식이나 링크 대신 이름을 직접 입력해주세요.');
  }
  function directoryMap(directory){
    return new Map(directory.map(m=>[String(m.id||m.memberId),{id:String(m.id||m.memberId),name:String(m.name||''),part:String(m.part||'')}]));
  }
  function reserveRows(source,capacity=200){
    const rows=source.map(r=>({...r,seats:r.seats.slice()}));
    if(!rows.length||!capacity)return rows;
    let label=Math.max(0,...rows.map(r=>Number(String(r.label).match(/^(\d+)\s*단$/)?.[1]||0)));
    while(rows.length<5)rows.unshift({label:(++label)+'단',offset:label%2/2,seats:[]});
    const width=Math.min(MAX_COLS,Math.max(Math.ceil(capacity/rows.length),...rows.map(r=>r.seats.length)));
    return rows.map(r=>({...r,seats:r.seats.concat(Array(Math.max(0,width-r.seats.length)).fill(null))}));
  }
  function build(ExcelJS,plan,directory,options={}){
    const wb=new ExcelJS.Workbook();
    wb.creator='광주교회 찬양대';
    const people=directoryMap(directory);
    allSeats(plan).forEach(s=>{if(!people.has(s.memberId))people.set(s.memberId,{id:s.memberId,name:s.name,part:s.part});});
    const labels={}, identities={}, starts={};
    people.forEach(m=>{
      const same=[...people.values()].filter(x=>key(x.name)===key(m.name));
      let label=m.name;
      if(same.length>1)label+=' ['+m.part+(same.filter(x=>x.part===m.part).length>1?' · '+m.id:'')+']';
      labels[m.id]=label;
    });
    const needed=new Set(allSeats(plan).map(s=>s.memberId).concat(Object.keys(plan.attendees||{}).filter(id=>plan.attendees[id])));
    people.forEach(m=>{identities[labels[m.id]]={id:m.id,name:m.name,part:m.part};});
    const partRank=part=>{const index=partStyles.findIndex(p=>p[0]===part);return index<0?partStyles.length:index;};
    const choices=[...people.values()].filter(m=>m.name.trim()).sort((a,b)=>partRank(a.part)-partRank(b.part)||a.part.localeCompare(b.part,'ko')||a.name.localeCompare(b.name,'ko')||a.id.localeCompare(b.id));
    const partChoices=partStyles.map(([part])=>choices.filter(m=>m.part===part));
    function memberColors(sheet,cell,endAddress=cell.address){
      const rules=partStyles.flatMap(([,color],i)=>partChoices[i].length?[{type:'expression',formulae:['COUNTIF(ChoirPart'+i+',$'+cell.address+')>0'],style:{fill:{type:'pattern',pattern:'solid',fgColor:{argb:color}}}}]:[]);
      if(rules.length)sheet.addConditionalFormatting({ref:cell.address+':'+endAddress,rules});
    }
    function memberDropdown(cell){
      if(!choices.length)return;
      cell.dataValidation={type:'list',allowBlank:true,formulae:['ChoirMemberNames'],showErrorMessage:false};
    }
    function header(sheet,values){
      sheet.addRow(values);
      const row=sheet.lastRow;row.height=27;
      row.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF496452'}};c.font={name:'맑은 고딕',bold:true,color:{argb:'FFFFFFFF'},size:11};c.alignment={horizontal:'center',vertical:'middle'};});
    }
    boards.forEach(([name,field],b)=>{
      const rows=b?(plan[field]||[]):reserveRows(plan[field]||[],options.reserveSeats??200);
      if(b&&!rows.some(r=>r.seats.some(Boolean)))return;
      if(!rows.length||rows.length>MAX_ROWS||rows.some(r=>!r.seats.length||r.seats.length>MAX_COLS))fail('배치도는 1~40줄, 줄당 1~120칸까지 엑셀로 저장할 수 있습니다.');
      const width=Math.max(...rows.map(r=>r.seats.length));
      const offset=centerOffset(b&&plan.orchestraCenterOffset!==undefined?plan.orchestraCenterOffset:plan.centerOffset);
      const geometry=boardGeometry(rows),end=width*2+3,center=Math.max(3,Math.min(end-1,width+2+offset));
      starts[field]=Object.fromEntries(rows.map((r,i)=>[r.label,geometry[i].start]));
      const sheet=wb.addWorksheet(name,{views:[{state:'frozen',xSplit:2,ySplit:3,showGridLines:false}],pageSetup:{orientation:'landscape',paperSize:8,fitToPage:true,fitToWidth:1,fitToHeight:0}});
      sheet.properties.defaultRowHeight=38;
      sheet.getColumn(1).width=10;sheet.getColumn(2).width=9;
      for(let i=3;i<=end;i++)sheet.getColumn(i).width=7;
      sheet.addRow([plan.planName||plan.name||'자리배치']);sheet.mergeCells(1,1,1,end);
      sheet.getCell('A1').font={name:'맑은 고딕',size:18,bold:true,color:{argb:'FF24382B'}};
      sheet.addRow(['한 칸에 한 명 · 이름을 잘라내어 다른 빈칸에 붙여넣기 · 줄 삭제 가능 · B열 칸수로 사용할 좌석 수 지정']);
      sheet.mergeCells(2,1,2,end);sheet.getRow(2).height=24;
      sheet.getCell('A2').font={name:'맑은 고딕',size:10,color:{argb:'FF5D655F'}};
      header(sheet,['단','칸수']);
      const markerStart=Math.max(3,Math.min(end-1,center));
      sheet.mergeCells(3,markerStart,3,markerStart+1);
      const marker=sheet.getCell(3,markerStart);marker.value='센터';marker.font={name:'맑은 고딕',bold:true,size:12,color:{argb:'FF806019'}};marker.alignment={horizontal:'center',vertical:'middle'};
      rows.forEach((r,ri)=>{
        const g=geometry[ri],row=sheet.getRow(g.row);
        row.getCell(1).value=r.label;row.getCell(2).value=r.seats.length;
        row.height=42;
        [1,2].forEach(i=>{row.getCell(i).font={name:'맑은 고딕',size:11,bold:true};row.getCell(i).alignment={horizontal:'center',vertical:'middle'};});
        r.seats.forEach((seat,i)=>{
          const col=g.start+i*2;
          sheet.mergeCells(g.row,col,g.row,col+1);
          const c=row.getCell(col);c.value=seat?labels[seat.memberId]||seat.name:null;
          memberDropdown(c);
          c.font={name:'맑은 고딕',size:11,bold:!!seat,color:{argb:'FF222A25'}};
          c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF5F5F1'}};
          memberColors(sheet,c,row.getCell(col+1).address);
          c.alignment={horizontal:'center',vertical:'middle',wrapText:true};
          c.border={top:{style:'thin',color:{argb:'FF818C83'}},bottom:{style:'thin',color:{argb:'FF818C83'}},left:{style:'thin',color:{argb:'FF818C83'}},right:{style:'thin',color:{argb:'FF818C83'}}};
        });
        const gap=sheet.getRow(g.row+1);gap.height=12;
        gap.getCell(center).border={right:{style:'mediumDashed',color:{argb:'FFAD8A32'}}};
      });
      sheet.pageSetup.printTitlesRow='1:3';
    });
    const special=plan.specialSlots||{staff:[]};
    if([special.conductor,special.accompanist,...(special.staff||[])].some(Boolean)){
      const sheet=wb.addWorksheet('역할');header(sheet,['역할','번호','이름']);
      [['지휘',0,special.conductor],['반주',0,special.accompanist],...(special.staff||[]).map((s,i)=>['스태프',i,s])].forEach(([type,i,s])=>sheet.addRow([type,i+1,s?labels[s.memberId]||s.name:null]));
      for(let r=2;r<=sheet.rowCount;r++){memberDropdown(sheet.getCell(r,3));memberColors(sheet,sheet.getCell(r,3));}
      sheet.columns.forEach(c=>c.width=23);
    }
    if(choices.length){
      const list=wb.addWorksheet('_단원목록',{state:'veryHidden'});
      choices.forEach(m=>list.addRow([labels[m.id]]));
      wb.definedNames.add("'_단원목록'!$A$1:$A$"+choices.length,'ChoirMemberNames');
      partChoices.forEach((members,i)=>{
        if(!members.length)return;
        // Include plain names only when unambiguous, so manual input receives the same color.
        const values=[...new Set(members.flatMap(m=>[labels[m.id],...([...people.values()].filter(p=>key(p.name)===key(m.name)).length===1?[m.name]:[])]))];
        const col=i+2;
        values.forEach((value,r)=>{list.getCell(r+1,col).value=value;});
        wb.definedNames.add("'_단원목록'!$"+list.getColumn(col).letter+'$1:$'+list.getColumn(col).letter+'$'+values.length,'ChoirPart'+i);
      });
    }
    const meta=wb.addWorksheet('_앱정보',{state:'veryHidden'});
    meta.addRow([MAGIC,VERSION]);
    const data={identities,attendees:[...needed],flags:Object.fromEntries(allSeats(plan).map(s=>[s.memberId,{highlight:!!s.highlight,locked:!!s.locked}])),name:plan.planName||plan.name||'자리배치',title:plan.title||'',date:plan.date||'',program:plan.program||'전체 합창',centerOffset:plan.centerOffset||0,micSlots:plan.micSlots||[],attendeesLocked:!!plan.attendeesLocked,orchestra:!!wb.getWorksheet('관현악 배치'),roles:!!wb.getWorksheet('역할')};
    data.folder=String(plan.folder||'').normalize('NFC').trim().slice(0,60);
    data.orchestraCenterOffset=centerOffset(plan.orchestraCenterOffset===undefined?plan.centerOffset:plan.orchestraCenterOffset);
    data.micVisible=plan.micVisible!==false;
    data.firstOffsets={rows:plan.rows?.[0]?.offset||0,orchestraRows:plan.orchestraRows?.[0]?.offset||0};
    data.starts=starts;
    const json=JSON.stringify(data);
    for(let i=0;i<json.length;i+=8000)meta.addRow([json.slice(i,i+8000)]);
    return wb;
  }
  function parse(wb,directory){
    const meta=wb.getWorksheet('_앱정보');
    const version=meta?Number(text(meta.getCell('B1'))):0;
    if(!meta||text(meta.getCell('A1'))!==MAGIC||![1,2,VERSION].includes(version))fail('자리배치에서 내려받은 .xlsx 파일을 선택해주세요.');
    if(meta.rowCount>150)fail('엑셀의 연결정보가 너무 큽니다.');
    let json='';for(let r=2;r<=meta.rowCount;r++){
      const chunk=meta.getCell(r,1).value;
      if(typeof chunk!=='string')fail('엑셀 연결정보가 올바르지 않습니다.');
      json+=chunk;
    }
    const data=JSON.parse(json), people=directoryMap(directory), issues=[], warnings=[], used=new Map();
    if(!data.identities||!Array.isArray(data.attendees)||data.attendees.length>2000)fail('엑셀 연결정보가 올바르지 않습니다.');
    const addIssue=message=>{if(issues.length<50)issues.push(message);};
    function resolve(label,location){
      if(!label)return null;
      const normalized=memberLabelKey(label);
      const aliases=Object.entries(data.identities).filter(([name])=>memberLabelKey(name)===normalized);
      const identity=data.identities[label]||(aliases.length===1?aliases[0][1]:null);
      let m=identity&&people.get(identity.id);
      if(m&&key(m.name)!==key(identity.name))m=null;
      if(!m){
        const matches=[...people.values()].filter(x=>memberLabelKey(x.name)===normalized||memberLabelKey(x.name+' ['+x.part+']')===normalized);
        if(matches.length!==1){addIssue(location+' · '+label+(matches.length?' — 동명이인: 이름 뒤에 [파트]를 붙여주세요.':' — 명부에서 찾을 수 없습니다.'));return null;}
        m=matches[0];
      }
      if(used.has(m.id)){addIssue(location+' · '+m.name+' — '+used.get(m.id)+'에도 배치되어 있습니다.');return null;}
      used.set(m.id,location);
      const flags=data.flags?.[m.id]||{};
      return {memberId:m.id,name:m.name,part:m.part,highlight:flags.highlight===true,locked:flags.locked===true};
    }
    const result={rows:[],orchestraRows:[],specialSlots:{conductor:null,accompanist:null,staff:[null]}};
    boards.forEach(([name,field],b)=>{
      const sheet=wb.getWorksheet(name);
      if(!sheet){if(!b||data.orchestra)fail(name+' 시트가 없습니다.');return;}
      if(sheet.rowCount>MAX_ROWS*(version>=2?2:1)+3||sheet.columnCount>MAX_COLS*(version>=2?2:1)+(version>=2?3:2))fail(name+': 최대 40줄, 줄당 120칸까지 가능합니다.');
      if(text(sheet.getCell('A3'))!=='단'||text(sheet.getCell('B3'))!=='칸수')fail(name+': 단 / 칸수 제목을 유지해주세요.');
      const labels=new Set(), importedGeometry=[];
      for(let r=4;r<=sheet.rowCount;r++){
        const values=Array.from({length:sheet.columnCount},(_,i)=>text(sheet.getCell(r,i+1)));
        if(values.every(x=>!x))continue;
        let label=values[0];const count=Number(values[1]);
        if(!b&&/^\d+$/.test(label))label+='단';
        if(!label||label.length>20||labels.has(label))fail(name+' '+r+'행: 단 이름이 비었거나 중복되었습니다.');
        if(!Number.isInteger(count)||count<1||count>MAX_COLS)fail(name+' '+r+'행: 칸수를 1~120으로 입력해주세요.');
        let names=values.slice(2),start=3;
        if(version===3){
          const anchor=Number(data.starts?.[field]?.[label]);
          const first=Array.from({length:sheet.columnCount-2},(_,i)=>sheet.getCell(r,i+3)).find(c=>c.isMerged||text(c));
          start=Number.isInteger(anchor)&&anchor>=3&&anchor<=MAX_COLS*2+3?anchor:(first?.col||3);
          const end=start+count*2;
          if(end>MAX_COLS*2+4)fail(name+' '+r+'행: 칸수가 너무 많습니다.');
          for(let c=3;c<=sheet.columnCount;c++)if((c<start||c>=end)&&text(sheet.getCell(r,c)))fail(name+' '+r+'행: 칸수 밖에 이름이 있습니다. 이름을 옮기거나 B열 칸수를 늘려주세요.');
          names=Array.from({length:count},(_,i)=>{
            const col=start+i*2,a=sheet.getCell(r,col),b=sheet.getCell(r,col+1);
            if((a.isMerged&&a.master.address!==a.address)||(b.isMerged&&b.master.address!==a.address)||sheet.getCell(r+1,col).master.address===a.address)fail(name+' '+r+'행: 이름 칸의 병합 위치를 확인해주세요.');
            const left=text(a),right=b.isMerged?'':text(b);
            if(left&&right)fail(name+' '+r+'행: 한 칸에 이름은 한 명만 입력해주세요.');
            return left||right;
          });
        }else if(version===2){
          const cells=[];
          for(let col=3;col<=sheet.columnCount;col++){
            const c=sheet.getCell(r,col);
            if(c.isMerged){
              if(c.master.address!==c.address)continue;
              const next=sheet.getCell(r,col+1);
              if(!next.isMerged||next.master.address!==c.address||(col+2<=sheet.columnCount&&sheet.getCell(r,col+2).master.address===c.address)||sheet.getCell(r+1,col).master.address===c.address)fail(name+' '+r+'행: 이름 칸의 두 셀 병합을 유지해주세요.');
              cells.push(c);
            }else if(text(c))fail(name+' '+r+'행: 이름 칸 밖에 값이 있습니다.');
          }
          if((version===2?cells.length!==count:cells.length<count)||cells.some((c,i)=>c.col!==cells[0].col+i*2))fail(name+' '+r+'행: 이름 칸과 B열 칸수를 확인해주세요.');
          if(cells.slice(count).some(c=>text(c)))fail(name+' '+r+'행: 지정한 칸수 밖에 이름이 있습니다. 이름을 옮기거나 B열 칸수를 늘려주세요.');
          names=cells.map(text);start=cells[0].col;
          importedGeometry.push({start,row:r});
        }else if(values.slice(count+2).some(Boolean))fail(name+' '+r+'행: 칸수 밖에 이름이 있습니다. 칸수를 늘려주세요.');
        labels.add(label);
        const previous=result[field][result[field].length-1];
        const offset=/^\d+단$/.test(label)?Number(label.slice(0,-1))%2/2:(previous ? (previous.offset===0 ? .5 : 0) : (data.firstOffsets?.[field]===.5 ? .5 : 0));
        result[field].push({label,offset,seats:Array.from({length:count},(_,i)=>resolve(names[i]||'',name+' '+label+' '+(i+1)+'번'))});
      }
      if(!result[field].length||result[field].length>MAX_ROWS)fail(name+': 1~40줄을 유지해주세요.');
      if(version===2&&boardGeometry(result[field]).some((g,i)=>g.start!==importedGeometry[i].start))fail(name+': 줄의 위치가 바뀌었습니다. 이름 칸 안에서 수정해주세요.');
    });
    const roles=wb.getWorksheet('역할');
    if(data.roles&&!roles)fail('역할 시트가 없습니다.');
    if(roles){
      if(roles.rowCount>15||roles.columnCount>3)fail('역할 시트의 범위를 확인해주세요.');
      const positions=new Set();
      for(let r=2;r<=roles.rowCount;r++){
        const type=text(roles.getCell(r,1)), n=Number(text(roles.getCell(r,2))), label=text(roles.getCell(r,3));
        if(!type&&!label)continue;
        if(!['지휘','반주','스태프'].includes(type)||!Number.isInteger(n)||n<1||n>(type==='스태프'?12:1)||positions.has(type+n))fail('역할 '+r+'행: 역할 또는 번호를 확인해주세요.');
        positions.add(type+n);
        const seat=resolve(label,type+' '+n);
        if(type==='스태프'){while(result.specialSlots.staff.length<n)result.specialSlots.staff.push(null);result.specialSlots.staff[n-1]=seat;}
        else result.specialSlots[type==='지휘'?'conductor':'accompanist']=seat;
      }
    }
    const attendees={};
    const staleAttendees=new Set();
    data.attendees.forEach(id=>{if(people.has(id))attendees[id]=true;else staleAttendees.add(id);});
    if(staleAttendees.size)warnings.push('현재 명부에 없는 옛 참석 정보 '+staleAttendees.size+'건은 새 배치의 참석 명단에서 제외됩니다.');
    used.forEach((_,id)=>{attendees[id]=true;});
    const info=field=>String(data[field]||'').slice(0,150);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(info('date'))||new Date(info('date')+'T00:00:00Z').toISOString().slice(0,10)!==info('date'))fail('날짜 정보가 올바르지 않습니다.');
    Object.assign(result,{planId:'',planName:info('name')+' (엑셀)',title:info('title'),date:info('date'),program:info('program'),attendees,attendeesLocked:data.attendeesLocked===true,autoFit:false,partSubmissions:{},history:[],centerOffset:centerOffset(data.centerOffset),orchestraCenterOffset:centerOffset(data.orchestraCenterOffset===undefined?data.centerOffset:data.orchestraCenterOffset),micSlots:Array.isArray(data.micSlots)?data.micSlots.slice(0,MAX_COLS).map(v=>v===true):[]});
    result.folder=String(data.folder||'').normalize('NFC').trim().slice(0,60);
    result.micVisible=data.micVisible!==false;
    return {snapshot:result,issues,warnings,placed:used.size,attended:Object.keys(attendees).length,empty:result.rows.concat(result.orchestraRows).reduce((n,r)=>n+r.seats.filter(s=>!s).length,0),rows:result.rows.length+result.orchestraRows.length};
  }
  const api={build,parse,allSeats,boardGeometry,reserveRows};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SeatingWorkbook=api;
})(typeof globalThis==='object'?globalThis:this);
