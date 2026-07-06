# Firebase 사용량 확인 워크플로우

Firebase 비용과 사용량을 빠르게 확인할 때는 아래 스크립트를 실행한다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\firebase-usage-report.ps1
```

보고서를 파일로 남기려면:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\firebase-usage-report.ps1 -SavePath .\reports\firebase-usage-latest.md
```

## 처음 한 번만 필요한 것

Firebase CLI 로그인이 필요하다.

```powershell
npx firebase-tools login
```

## 확인되는 항목

- 현재 Firebase 계정과 프로젝트
- Billing 연결 여부
- Firestore 위치, 에디션, 저장량
- Storage 버킷, 위치, 저장량, 파일 수
- 최근 24시간, 7일, 30일 Firestore 읽기/쓰기/삭제
- 최근 24시간, 7일, 30일 Storage 다운로드/업로드/API 요청
- 최근 30일 기준 Firestore 무료분 초과량과 대략 비용
- 읽기 사용량이 많았던 날짜 상위 5개

## 주의

- 이 스크립트는 앱의 Firestore 컬렉션을 직접 읽지 않는다.
- Google Cloud Monitoring/Billing API만 조회하므로 단원 앱의 read/write 사용량을 늘리지 않는다.
- 비용은 대략치다. 실제 청구 금액은 Firebase Console 또는 Google Cloud Billing을 최종 기준으로 확인한다.
- Firebase 가격 정책이 바뀌면 `scripts/firebase-usage-report.ps1` 안의 단가 상수를 조정해야 한다.
