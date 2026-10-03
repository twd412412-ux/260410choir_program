# 찬양의밤 리허설 출석

## 사용

- 홈 권한자 도구 또는 공개 자리배치도의 `리허설 출석`에서 진입.
- 최초 관리자는 `관리자 날짜·배치도 설정`에서 공개된 **전체 배치도**를 선택하고 설정 저장.
- 기본 날짜: 2026-09-20, 2026-10-04, 2026-10-11, 2026-10-12, 2026-10-16. 9/27 제외.
- 단원 기준, 기존 좌석의 지그재그·센터·행 간격을 기준으로 표시.
- 자리 탭은 출석 체크/체크 취소. `미체크 결석`은 담당 필터의 미체크만 확인 후 일괄 결석 처리.
- `출석 저장`으로 서버 반영. 조회 실패 재시도, 저장 실패 입력 보존, 날짜 전환/닫기 시 미저장 확인.
- 출석률은 저장된 기록과 지정 날짜 중 한국시간 오늘까지의 회차만 사용. 미체크 수 별도 표시.

## 데이터·권한

- 설정: `settings/rehearsalAttendance` (`dates`, `planId`, `version`). 관리자만 설정 가능.
- 기록: `rehearsalAttendance/YYYY-MM-DD`. 정규 `attendance`와 분리되어 주일 결산에 섞이지 않음.
- 기존 `attendanceAdmin` callable의 `rehearsalLoad`, `rehearsalConfigure`, `rehearsalSave` 액션.
- 조회는 `attendance.view` 또는 `attendance.check`; 변경은 `attendance.check` + 기존 담당 파트 scope.
- 신규 출석 권한이나 자리배치 수정 권한을 자동 부여하지 않음.
- 클라이언트가 대상 이름/파트를 지정해 권한을 우회할 수 없음. 서버가 명부의 memberId, 담당 파트, 활성 여부, 출첵 제외, 등록일을 검증.
- 관리자 설정 날짜 외의 저장과 미래 회차 저장 금지.
- memberId 없는 옛 좌석은 임의 이름 매칭 없이 `대상 제외`로 표시.
- 변경한 단원만 트랜잭션 병합. 같은 단원의 상충 수정은 거부, 다른 파트 기록은 보존.
- 저장 중 공개 배치 인원 변경 및 설정 변경 검증. 클라이언트 변경값 그대로 덮어쓰기 금지.
- 날짜 제외 시 기록 삭제 없음. 다시 추가하면 기록 재조회 가능.
- 기준 배치도 변경 후 과거 기록은 보존. 각 저장 문서의 `memberIds`는 당시 대상 목록을 보관.
- 새 컬렉션은 일반 Firestore 직접 읽기/쓰기 허용 규칙이 없음. 모든 접근은 callable 경유.

## 검증·배포

- 서버: `node tests/rehearsal-attendance-server.cjs`
- 화면: `node tests/rehearsal-attendance-browser.cjs` (Playwright 런타임 필요)
- 추가 회귀: 출결 서버, 인증 세션, 저장 복구, 공개 자리배치 개인 초점.
- 웹 코드 외에 Firebase `functions:attendanceAdmin` 배포 필요. 보안 규칙 변경 없음.
