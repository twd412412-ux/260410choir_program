(function () {
  'use strict';
  var state=null, loadToken=0;
  function box(){return document.getElementById('rehearsalAttendanceBody');}
  function permitted(){return canViewAttendance()||canCheckAttendance();}
  function dirty(){return state&&Object.keys(state.changes).length>0;}
  function discard(){return !dirty()||confirm('저장하지 않은 출석 체크가 있습니다. 변경을 버릴까요?');}
  function eligible(member,date){return member&&(!/^\d{4}-\d{2}-\d{2}$/.test(member.startDate)||member.startDate<=date);}
  function inScope(member){return state.scope.indexOf('ALL')!==-1||state.scope.indexOf(member.part)!==-1||state.scope.indexOf(member.subPart)!==-1;}
  function visible(member){return member&&(state.part==='all'||member.part===state.part||member.subPart===state.part)&&(!state.query||publicSeatingMatches(member,state.query));}
  function status(id){return Object.prototype.hasOwnProperty.call(state.changes,id)?state.changes[id]:((state.sessions[state.date]||{}).records||{})[id]||'';}
  function editable(member){return !!(member&&state.canEdit&&!state.busy&&state.date<=state.today&&eligible(member,state.date)&&inScope(member)&&visible(member));}
  function members(){return state.members.filter(function(m){return eligible(m,state.date)&&visible(m)&&inScope(m);});}
  function dateLabel(date){return date.slice(5).replace('-','/')+' ('+['일','월','화','수','목','금','토'][new Date(date+'T00:00:00Z').getUTCDay()]+')';}
  function errorText(e){return e&&e.message||'요청을 처리하지 못했습니다. 다시 시도해주세요.';}
  function selectedDate(data,previous){return data.config.dates.indexOf(previous)!==-1?previous:data.config.dates.find(function(d){return d>=data.today;})||data.config.dates[data.config.dates.length-1]||'';}

  window.openRehearsalAttendance=function(){
    if(!permitted())return showToast('출결 권한이 필요합니다');
    if(!discard())return;
    openModal('modalRehearsalAttendance');
    return load();
  };
  function load(){
    var token=++loadToken,previous=state&&state.date,actor=(currentUser&&currentUser.id||'')+'|'+adminRole;
    box().innerHTML='<p role="status">리허설 출석 불러오는 중...</p>';
    return withLoadDeadline(attendanceAdminCall('rehearsalLoad',{}),20000).then(function(data){
      if(token!==loadToken||!permitted()||actor!==((currentUser&&currentUser.id||'')+'|'+adminRole))return;
      state=Object.assign({},data,{actor:actor,date:selectedDate(data,previous),part:'all',board:'choir',query:'',zoom:1,busy:false,changes:{},error:'',configDates:data.config.dates.slice()});
      state.memberMap={};state.members.forEach(function(m){state.memberMap[m.id]=m;});
      render();
    }).catch(function(e){if(token===loadToken)box().innerHTML='<p class="ra-error" role="alert">'+escHtml(errorText(e))+'</p><button class="btn" onclick="RehearsalAttendance.reload()">다시 시도</button>';});
  }
  function seatHtml(seat){
    if(!seat)return '<div class="public-seating-seat empty"><b>빈칸</b></div>';
    var member=state.memberMap[seat.memberId],value=status(seat.memberId),can=editable(member);
    var label=!member?'대상 제외':!eligible(member,state.date)?'등록 전':value||'미체크';
    var dim=(state.query&&!String(seat.name||'').includes(state.query)&&!String(seat.part||'').includes(state.query))||member&&!visible(member);
    return '<button type="button" class="public-seating-seat '+partClass(member?member.part:seat.part)+(value==='출석'?' ra-present':value==='결석'?' ra-absent':'')+(dim?' ra-dim':'')+'" '+(!can?'disabled ':'')+'data-member-id="'+escAttr(seat.memberId||'')+'" aria-label="'+escAttr((seat.name||'')+' '+label)+'" aria-pressed="'+(value==='출석')+'" onclick="RehearsalAttendance.toggle(this.dataset.memberId)"><b>'+escHtml(seat.name||'이름 없음')+'</b><small>'+label+'</small></button>';
  }
  function boardHtml(){
    var rows=state.board==='orchestra'?state.plan.orchestraRows||[]:state.plan.rows||[];
    var max=publicSeatingMaxSeatCount(rows),width=seatingLeadWidth()*2+seatingRowWidthForSeatCount(max);
    var height=rows.length*64+64,center=seatingCenterLeftForSeatCount(max)+seatingCenterOffsetPixels(seatingPlanCenterOffset(state.plan,state.board),true);
    var html='<div class="ra-scroll" aria-label="단원 기준 리허설 출석 배치도"><div class="ra-scale" style="width:'+width*state.zoom+'px;height:'+height*state.zoom+'px"><div class="public-seating-board ra-board member-view" style="width:'+width+'px;height:'+height+'px;transform:scale('+state.zoom+')"><div class="ra-front">지휘자 방향 · 단원 기준</div><div class="public-seating-center-line" style="left:'+center+'px;top:46px"></div>';
    rows.map(function(row,r){return {row:row,r:r};}).reverse().forEach(function(entry){
      var row=entry.row,stagger=seatingRowDisplayOffset(row,entry.r,rows)===.5;
      var left=Math.max(0,seatingRowLeftForSeatCount(row.seats.length,max)-(stagger?seatingSeatPitch()/2:0));
      html+='<div class="public-seating-row"><div class="public-seating-row-label">'+escHtml(row.label||'')+'</div><div class="public-seating-row-count"></div><div class="public-seating-line" style="margin-left:'+left+'px">'+row.seats.slice().reverse().map(seatHtml).join('')+'</div></div>';
    });
    return html+'</div></div></div>';
  }
  function summaryHtml(){
    var dates=state.config.dates.filter(function(date){return date<=state.today;});
    var list=state.members.filter(function(m){return visible(m)&&inScope(m);}).map(function(m){
      var expected=dates.filter(function(date){var session=state.sessions[date];return eligible(m,date)&&(!session||!Array.isArray(session.memberIds)||session.memberIds.indexOf(m.id)!==-1);});
      var present=0,checked=0;expected.forEach(function(date){var value=((state.sessions[date]||{}).records||{})[m.id];if(value)checked++;if(value==='출석')present++;});
      return {member:m,total:expected.length,present:present,unchecked:expected.length-checked,rate:expected.length?Math.round(present/expected.length*100):null};
    }).sort(function(a,b){return (a.rate===null?101:a.rate)-(b.rate===null?101:b.rate)||a.member.name.localeCompare(b.member.name,'ko');});
    return '<details class="ra-summary"><summary>리허설 출석률 · '+dates.length+'회</summary><p class="ra-status">'+dates.map(dateLabel).join(' · ')+' · 저장된 체크 기준</p><div class="ra-table-scroll"><table><thead><tr><th>단원</th><th>파트</th><th>출석</th><th>미체크</th><th>출석률</th></tr></thead><tbody>'+list.map(function(row){return '<tr><td>'+escHtml(row.member.name)+'</td><td>'+escHtml(row.member.part)+'</td><td>'+row.present+'/'+row.total+'</td><td>'+row.unchecked+'</td><td>'+(row.rate===null?'-':row.rate+'%')+'</td></tr>';}).join('')+'</tbody></table></div></details>';
  }
  function configHtml(){
    if(!state.canManage)return '';
    return '<details class="ra-config" '+(!state.plan?'open':'')+'><summary>관리자 날짜·배치도 설정</summary><label for="raPlan">전체 기준 배치도</label><select id="raPlan" onchange="RehearsalAttendance.configPlan(this.value)">'+(!state.config.planId?'<option value="">공개된 전체 배치도 선택</option>':'')+state.plans.map(function(plan){return '<option value="'+escAttr(plan.id)+'" '+(plan.id===(state.configPlan||state.config.planId)?'selected':'')+'>'+escHtml(plan.name)+'</option>';}).join('')+'</select><div class="ra-dates">'+state.configDates.map(function(date){return '<span class="ra-date">'+dateLabel(date)+'<button type="button" data-date="'+date+'" onclick="RehearsalAttendance.removeDate(this.dataset.date)" aria-label="'+date+' 제외">×</button></span>';}).join('')+'</div><div class="ra-config-row"><input type="date" id="raAddDate" aria-label="리허설 날짜 추가"><button class="btn" onclick="RehearsalAttendance.addDate()">날짜 추가</button><button class="btn btn-primary" id="raConfigSave" '+(state.busy?'disabled':'')+' onclick="RehearsalAttendance.configure()">설정 저장</button></div><p class="ra-status">날짜를 제외해도 기존 출석 기록은 삭제되지 않습니다.</p></details>';
  }
  function render(){
    if(!state||!permitted())return;
    var list=members(),present=list.filter(function(m){return status(m.id)==='출석';}).length,absent=list.filter(function(m){return status(m.id)==='결석';}).length;
    var session=state.sessions[state.date]||{},parts=['all','S1','S2','T1','T2','관현악'];
    var html=(state.plan?'<p class="ra-status"><strong>'+escHtml(state.plan.name||state.plan.title||'전체 배치도')+'</strong></p>':'')+'<div class="ra-toolbar"><label>날짜<select id="raDate" '+(state.busy?'disabled':'')+' onchange="RehearsalAttendance.changeDate(this.value)">'+state.config.dates.map(function(date){return '<option value="'+date+'" '+(date===state.date?'selected':'')+'>'+dateLabel(date)+'</option>';}).join('')+'</select></label><input type="search" aria-label="단원 검색" placeholder="이름/파트 검색" value="'+escAttr(state.query)+'" oninput="RehearsalAttendance.search(this.value)"><label>확대<input type="range" min="50" max="150" step="10" value="'+Math.round(state.zoom*100)+'" aria-label="배치도 확대" oninput="RehearsalAttendance.zoom(this.value)"></label><button class="btn" '+(state.busy?'disabled':'')+' onclick="RehearsalAttendance.reload()">새로고침</button></div>';
    html+='<div class="ra-filters">'+parts.map(function(part){var count=state.members.filter(function(m){return eligible(m,state.date)&&inScope(m)&&(part==='all'||m.part===part||m.subPart===part);}).length;return '<button type="button" aria-pressed="'+(state.part===part)+'" data-part="'+part+'" onclick="RehearsalAttendance.part(this.dataset.part)">'+(part==='all'?'담당 전체':part)+' '+count+'</button>';}).join('')+'</div>';
    html+='<p class="ra-status" role="status">출석 '+present+' · 결석 '+absent+' · 미체크 '+(list.length-present-absent)+' / 담당 '+list.length+'명'+(state.date>state.today?' · 예정 회차':'')+'</p>';
    if(state.error)html+='<p class="ra-error" role="alert">'+escHtml(state.error)+'</p>';
    if(state.plan){
      html+='<div class="ra-filters" aria-label="배치 선택"><button aria-pressed="'+(state.board==='choir')+'" onclick="RehearsalAttendance.board(\'choir\')">합창</button>'+(state.plan.orchestraRows&&state.plan.orchestraRows.length?'<button aria-pressed="'+(state.board==='orchestra')+'" onclick="RehearsalAttendance.board(\'orchestra\')">관현악</button>':'')+'</div>'+boardHtml();
      var seatIds=new Set([].concat(state.plan.rows||[],state.plan.orchestraRows||[]).flatMap(function(row){return row.seats||[];}).filter(Boolean).map(function(seat){return seat.memberId;}));
      var extra=state.members.filter(function(m){return !seatIds.has(m.id);});
      if(extra.length)html+='<div class="ra-filters">'+extra.map(function(m){return seatHtml({memberId:m.id,name:m.name,part:m.part});}).join('')+'</div>';
      html+=summaryHtml();
    }else html+='<p class="ra-status">관리자가 전체 기준 배치도를 지정하면 출석 체크를 시작할 수 있습니다.</p>';
    html+=configHtml();
    html+='<div class="ra-footer"><span id="raSaveStatus" role="status">'+(state.busy?'저장 중...':dirty()?'미저장 '+Object.keys(state.changes).length+'명':session.updatedAt?'저장 · '+escHtml(seatingPublishedTime(session.updatedAt))+' · '+escHtml(session.updatedBy||''):'체크 내역 없음')+'</span><div class="ra-filters"><button class="btn" '+(!state.canEdit||state.busy||!state.plan||state.date>state.today?'disabled':'')+' onclick="RehearsalAttendance.markRemaining()">미체크 결석</button><button class="btn btn-primary" id="raSave" '+(!dirty()||state.busy?'disabled':'')+' onclick="RehearsalAttendance.save()">출석 저장</button></div></div>';
    var old=box().querySelector('.ra-scroll'),scroll=old?{x:old.scrollLeft,y:old.scrollTop}:null;
    box().innerHTML=html;
    var next=box().querySelector('.ra-scroll');if(next&&scroll){next.scrollLeft=scroll.x;next.scrollTop=scroll.y;}
  }
  function change(id,value){var baseline=((state.sessions[state.date]||{}).records||{})[id]||'';if(value===baseline)delete state.changes[id];else state.changes[id]=value;}
  window.RehearsalAttendance={
    close:function(){closeModal('modalRehearsalAttendance');},
    canClose:function(){if(state&&state.busy||!discard())return false;loadToken++;state=null;return true;},
    syncAccess:function(){if(state&&(!permitted()||state.actor!==((currentUser&&currentUser.id||'')+'|'+adminRole))){loadToken++;state=null;var modal=document.getElementById('modalRehearsalAttendance');modal.classList.remove('active');box().innerHTML='';syncLayoutState();}},
    reload:function(){if(state&&state.busy||!discard())return;return load();},
    changeDate:function(date){if(state.busy||!discard()){render();return;}if(state.config.dates.indexOf(date)===-1)return;state.date=date;state.changes={};state.error='';render();},
    toggle:function(id){var member=state.memberMap[id];if(!editable(member))return;change(id,status(id)==='출석'?'':'출석');render();},
    part:function(part){state.part=part;render();},board:function(board){state.board=board;render();},
    configPlan:function(id){state.configPlan=id;},
    search:function(query){state.query=query;var input=box().querySelector('input[type=search]'),start=input&&input.selectionStart;render();input=box().querySelector('input[type=search]');input.focus();if(start!==null)try{input.setSelectionRange(start,start);}catch(e){}},
    zoom:function(value){state.zoom=Math.max(.5,Math.min(1.5,Number(value)/100));var board=box().querySelector('.ra-board'),scale=box().querySelector('.ra-scale');if(board){board.style.transform='scale('+state.zoom+')';scale.style.width=parseFloat(board.style.width)*state.zoom+'px';scale.style.height=parseFloat(board.style.height)*state.zoom+'px';}},
    markRemaining:function(){if(!state.canEdit||state.busy||state.date>state.today)return;var list=members().filter(function(m){return !status(m.id);});if(!list.length)return showToast('미체크 단원이 없습니다');if(!confirm('현재 담당 필터의 미체크 '+list.length+'명을 결석으로 표시할까요?'))return;list.forEach(function(m){change(m.id,'결석');});render();},
    save:function(){
      if(!state||state.busy||!dirty()||!state.canEdit)return;
      var changes=Object.keys(state.changes).map(function(id){return {id:id,status:state.changes[id],baselineStatus:((state.sessions[state.date]||{}).records||{})[id]||''};});
      var target=state;
      state.busy=true;state.error='';render();
      return withLoadDeadline(attendanceAdminCall('rehearsalSave',{date:state.date,planId:state.config.planId,changes:changes}),20000).then(function(result){if(state!==target)return;state.sessions[state.date]=result.session;state.changes={};writeLog('리허설 출석 저장',state.date+' 변경 '+changes.length+'명');}).catch(function(e){if(state===target)state.error=errorText(e)+' 입력한 체크는 유지됩니다.';}).finally(function(){if(state===target){state.busy=false;render();}});
    },
    addDate:function(){var date=document.getElementById('raAddDate').value;if(!date)return;if(state.configDates.indexOf(date)===-1)state.configDates.push(date);state.configDates.sort();var plan=document.getElementById('raPlan').value;render();document.getElementById('raPlan').value=plan;box().querySelector('.ra-config').open=true;},
    removeDate:function(date){var plan=document.getElementById('raPlan').value;state.configDates=state.configDates.filter(function(d){return d!==date;});render();document.getElementById('raPlan').value=plan;box().querySelector('.ra-config').open=true;},
    configure:function(){
      if(!state.canManage||state.busy||!discard())return;
      var planId=document.getElementById('raPlan').value;
      if(!planId)return showToast('전체 기준 배치도를 선택해주세요');
      var target=state;
      state.busy=true;render();
      return withLoadDeadline(attendanceAdminCall('rehearsalConfigure',{dates:state.configDates,planId:planId,baselineVersion:state.config.version}),20000).then(function(){if(state!==target)return;state.changes={};return load();}).catch(function(e){if(state!==target)return;state.busy=false;showToast(errorText(e));render();});
    }
  };
  window.addEventListener('beforeunload',function(e){if(dirty()||state&&state.busy){e.preventDefault();e.returnValue='저장하지 않은 리허설 출석이 있습니다.';}});
}());
