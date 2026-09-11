(function(root){
  'use strict';
  const MAGIC='choir-seating-xlsx', VERSION=1, MAX_ROWS=40, MAX_COLS=120;
  const boards=[['합창 배치','rows'],['관현악 배치','orchestraRows']];
  const copy=value=>JSON.parse(JSON.stringify(value));
  const key=value=>String(value||'').normalize('NFC').replace(/\s+/g,'').trim();
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
  function build(ExcelJS,plan,directory){
    const wb=new ExcelJS.Workbook();
    wb.creator='광주교회 찬양대';
    const people=directoryMap(directory);
    allSeats(plan).forEach(s=>{if(!people.has(s.memberId))people.set(s.memberId,{id:s.memberId,name:s.name,part:s.part});});
    const labels={}, identities={};
    people.forEach(m=>{
      const same=[...people.values()].filter(x=>key(x.name)===key(m.name));
      let label=m.name;
      if(same.length>1)label+=' ['+m.part+(same.filter(x=>x.part===m.part).length>1?' · '+m.id:'')+']';
      labels[m.id]=label;
    });
    const needed=new Set(allSeats(plan).map(s=>s.memberId).concat(Object.keys(plan.attendees||{}).filter(id=>plan.attendees[id])));
    needed.forEach(id=>{const m=people.get(id);if(m)identities[labels[id]]={id:m.id,name:m.name,part:m.part};});
    function header(sheet,values){
      sheet.addRow(values);
      const row=sheet.lastRow;row.height=27;
      row.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF496452'}};c.font={name:'맑은 고딕',bold:true,color:{argb:'FFFFFFFF'},size:11};c.alignment={horizontal:'center',vertical:'middle'};});
    }
    boards.forEach(([name,field],b)=>{
      const rows=plan[field]||[];
      if(b&&!rows.some(r=>r.seats.some(Boolean)))return;
      if(!rows.length||rows.length>MAX_ROWS||rows.some(r=>!r.seats.length||r.seats.length>MAX_COLS))fail('배치도는 1~40줄, 줄당 1~120칸까지 엑셀로 저장할 수 있습니다.');
      const width=Math.max(...rows.map(r=>r.seats.length));
      const sheet=wb.addWorksheet(name,{views:[{state:'frozen',xSplit:2,ySplit:3}],pageSetup:{orientation:'landscape',paperSize:8,fitToPage:true,fitToWidth:1,fitToHeight:0}});
      sheet.properties.defaultRowHeight=38;
      sheet.getColumn(1).width=10;sheet.getColumn(2).width=9;
      for(let i=3;i<=width+2;i++)sheet.getColumn(i).width=14;
      sheet.addRow([plan.planName||plan.name||'자리배치']);sheet.mergeCells(1,1,1,Math.max(3,width+2));
      sheet.getCell('A1').font={name:'맑은 고딕',size:18,bold:true,color:{argb:'FF24382B'}};
      sheet.addRow(['이름을 옮기면 자리도 이동합니다. 빈자리는 이름을 지우고, 칸을 늘릴 때는 칸수도 수정해주세요.']);
      sheet.mergeCells(2,1,2,Math.max(3,width+2));sheet.getRow(2).height=24;
      sheet.getCell('A2').font={name:'맑은 고딕',size:10,color:{argb:'FF5D655F'}};
      header(sheet,['단','칸수',...Array.from({length:width},(_,i)=>i+1)]);
      rows.forEach(r=>{
        const row=sheet.addRow([r.label,r.seats.length,...r.seats.map(s=>s?labels[s.memberId]||s.name:null)]);
        row.height=42;
        row.eachCell({includeEmpty:true},(c,i)=>{
          const seat=i>2?r.seats[i-3]:null;
          const color={S1:'FFE3EAF8',S2:'FFF8E2E4',T1:'FFE5EEDC',T2:'FFFFE7B5'}[seat?.part]||'FFF5F5F1';
          c.font={name:'맑은 고딕',size:11,bold:!!seat,color:{argb:'FF222A25'}};
          c.fill={type:'pattern',pattern:'solid',fgColor:{argb:color}};
          c.alignment={horizontal:'center',vertical:'middle',wrapText:true};
          c.border={top:{style:'thin',color:{argb:'FFD8DDD7'}},bottom:{style:'thin',color:{argb:'FFD8DDD7'}},left:{style:'thin',color:{argb:'FFD8DDD7'}},right:{style:'thin',color:{argb:'FFD8DDD7'}}};
        });
      });
      sheet.pageSetup.printTitlesRow='1:3';
    });
    const special=plan.specialSlots||{staff:[]};
    if([special.conductor,special.accompanist,...(special.staff||[])].some(Boolean)){
      const sheet=wb.addWorksheet('역할');header(sheet,['역할','번호','이름']);
      [['지휘',0,special.conductor],['반주',0,special.accompanist],...(special.staff||[]).map((s,i)=>['스태프',i,s])].forEach(([type,i,s])=>sheet.addRow([type,i+1,s?labels[s.memberId]||s.name:null]));
      sheet.columns.forEach(c=>c.width=23);
    }
    const meta=wb.addWorksheet('_앱정보',{state:'veryHidden'});
    meta.addRow([MAGIC,VERSION]);
    const data={identities,attendees:[...needed],flags:Object.fromEntries(allSeats(plan).map(s=>[s.memberId,{highlight:!!s.highlight,locked:!!s.locked}])),name:plan.planName||plan.name||'자리배치',title:plan.title||'',date:plan.date||'',program:plan.program||'전체 합창',centerOffset:plan.centerOffset||0,micSlots:plan.micSlots||[],attendeesLocked:!!plan.attendeesLocked,orchestra:!!wb.getWorksheet('관현악 배치'),roles:!!wb.getWorksheet('역할')};
    const json=JSON.stringify(data);
    for(let i=0;i<json.length;i+=8000)meta.addRow([json.slice(i,i+8000)]);
    return wb;
  }
  function parse(wb,directory){
    const meta=wb.getWorksheet('_앱정보');
    if(!meta||text(meta.getCell('A1'))!==MAGIC||Number(text(meta.getCell('B1')))!==VERSION)fail('자리배치에서 내려받은 .xlsx 파일을 선택해주세요.');
    if(meta.rowCount>150)fail('엑셀의 연결정보가 너무 큽니다.');
    let json='';for(let r=2;r<=meta.rowCount;r++){
      const chunk=meta.getCell(r,1).value;
      if(typeof chunk!=='string')fail('엑셀 연결정보가 올바르지 않습니다.');
      json+=chunk;
    }
    const data=JSON.parse(json), people=directoryMap(directory), issues=[], used=new Map();
    if(!data.identities||!Array.isArray(data.attendees)||data.attendees.length>2000)fail('엑셀 연결정보가 올바르지 않습니다.');
    const addIssue=message=>{if(issues.length<50)issues.push(message);};
    function resolve(label,location){
      if(!label)return null;
      const identity=data.identities[label];
      let m=identity&&people.get(identity.id);
      if(m&&key(m.name)!==key(identity.name))m=null;
      if(!m){
        const normalized=key(label);
        const matches=[...people.values()].filter(x=>key(x.name)===normalized||key(x.name+' ['+x.part+']')===normalized);
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
      if(sheet.rowCount>MAX_ROWS+3||sheet.columnCount>MAX_COLS+2)fail(name+': 최대 40줄, 줄당 120칸까지 가능합니다.');
      if(text(sheet.getCell('A3'))!=='단'||text(sheet.getCell('B3'))!=='칸수')fail(name+': 단 / 칸수 제목을 유지해주세요.');
      const labels=new Set();
      for(let r=4;r<=sheet.rowCount;r++){
        const values=Array.from({length:sheet.columnCount},(_,i)=>text(sheet.getCell(r,i+1)));
        if(values.every(x=>!x))continue;
        let label=values[0];const count=Number(values[1]);
        if(!b&&/^\d+$/.test(label))label+='단';
        if(!label||label.length>20||labels.has(label))fail(name+' '+r+'행: 단 이름이 비었거나 중복되었습니다.');
        if(!Number.isInteger(count)||count<1||count>MAX_COLS)fail(name+' '+r+'행: 칸수를 1~120으로 입력해주세요.');
        if(values.slice(count+2).some(Boolean))fail(name+' '+r+'행: 칸수 밖에 이름이 있습니다. 칸수를 늘려주세요.');
        labels.add(label);
        result[field].push({label,offset:/^\d+단$/.test(label)?Number(label.slice(0,-1))%2/2:(result[field].length%2)/2,seats:Array.from({length:count},(_,i)=>resolve(values[i+2]||'',name+' '+label+' '+(i+1)+'번'))});
      }
      if(!result[field].length)fail(name+': 최소 한 줄은 있어야 합니다.');
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
    data.attendees.forEach(id=>{if(people.has(id))attendees[id]=true;else addIssue('참석 단원 '+id+' — 명부에서 찾을 수 없습니다.');});
    used.forEach((_,id)=>{attendees[id]=true;});
    const info=field=>String(data[field]||'').slice(0,150);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(info('date'))||new Date(info('date')+'T00:00:00Z').toISOString().slice(0,10)!==info('date'))fail('날짜 정보가 올바르지 않습니다.');
    Object.assign(result,{planId:'',planName:info('name')+' (엑셀)',title:info('title'),date:info('date'),program:info('program'),attendees,attendeesLocked:data.attendeesLocked===true,autoFit:false,partSubmissions:{},history:[],centerOffset:[-1,0,1].includes(data.centerOffset)?data.centerOffset:0,micSlots:Array.isArray(data.micSlots)?data.micSlots.slice(0,MAX_COLS).map(v=>v===true):[]});
    return {snapshot:result,issues,placed:used.size,attended:Object.keys(attendees).length,empty:result.rows.concat(result.orchestraRows).reduce((n,r)=>n+r.seats.filter(s=>!s).length,0),rows:result.rows.length+result.orchestraRows.length};
  }
  const api={build,parse,allSeats};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SeatingWorkbook=api;
})(typeof globalThis==='object'?globalThis:this);
