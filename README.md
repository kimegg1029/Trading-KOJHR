# OZU TRADING

개인용 2계정(오주·혜령) 업비트 거래 앱의 서버 포함 프로젝트입니다. 화면의 계산기 메뉴는 **피라미드**로 변경했습니다.

## 현재 단계와 안전장치

- `public/index.html`: 기존 UI/피라미드 화면을 보존했습니다. 화면의 주문 버튼은 아직 시뮬레이션 로직을 사용하므로 실제 주문을 보내지 않습니다.
- `server/`: 로그인 세션, 암호화된 API 키 저장, 업비트 인증 요청, 잔고/시세/미체결 조회 API, 피라미드 지정가 주문 API의 첫 서버 구현입니다.
- 실제 주문 API는 `LIVE_TRADING_ENABLED=false`이면 서버에서 거부됩니다. 프런트엔드 연결·실계정 검증 전에는 이 설정을 켜지 마세요.
- 출금 기능은 구현하지 않았습니다. API 키에도 출금 권한을 부여하지 마세요.
- API 비밀키, 비밀번호 원문, `.env` 파일을 GitHub에 올리지 마세요.

## 요구 사항

- Node.js 20 이상
- PostgreSQL 데이터베이스
- HTTPS가 적용되는 서버 호스팅 (Render 설정 파일 `render.yaml` 포함)

## 로컬 실행

1. 의존성 설치: `npm install`
2. `.env.example`을 `.env`로 복사하고 값을 설정합니다.
3. 암호화 키/세션 비밀값 생성: `node server/generate-secrets.js`
4. 각 사용자 비밀번호 해시 생성:
   - `node server/hash-password.js "오주가 사용할 긴 비밀번호"`
   - `node server/hash-password.js "혜령이 사용할 별도 긴 비밀번호"`
   출력된 해시를 `OZU_PASSWORD_HASH`, `HYERYEONG_PASSWORD_HASH`에 각각 저장합니다.
5. `DATABASE_URL`에 PostgreSQL 연결 문자열을 설정합니다.
6. 실행: `npm start`
7. 브라우저에서 `http://localhost:3000/api/health` 응답을 확인합니다.

## Render 배포

1. 이 프로젝트 전체를 GitHub 저장소의 루트에 업로드합니다. `public/index.html`, `server/`, `db/`, `package.json`, `render.yaml`이 루트 아래에 있어야 합니다.
2. Render에서 New → Blueprint로 저장소를 연결합니다.
3. `ENCRYPTION_KEY`, `OZU_PASSWORD_HASH`, `HYERYEONG_PASSWORD_HASH`는 Render 환경변수로 직접 설정합니다. 실제 키 값은 GitHub에 커밋하지 않습니다.
4. `ENCRYPTION_KEY`는 `node server/generate-secrets.js`가 출력한 Base64 32바이트 키를 사용합니다. 서비스가 운영된 뒤 이 키를 바꾸면 저장된 API 키를 복호화할 수 없게 되므로 안전하게 백업하고 교체하지 마세요.
5. 배포 후 `/api/health`가 응답하는지 확인합니다.

## Upbit API 키 권한

각 사용자는 본인 계정의 키를 직접 등록해야 합니다. 업비트 API 키는 잔고 조회, 주문하기, 주문조회 등 필요한 권한만 선택하고 **입출금 권한은 절대 부여하지 마세요**. 허용 IP는 호스팅 업체가 제공하는 고정 outbound IP를 확인한 뒤 등록해야 합니다. Render 서비스가 고정 outbound IP를 보장하지 않는 요금제라면 API 허용 IP 정책을 충족하는 호스팅을 먼저 선택해야 합니다.

## API 개요

- `GET /api/health`
- `POST /api/auth/login` `{ "user": "오주", "password": "..." }`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/credentials/upbit` `{ "accessKey": "...", "secretKey": "..." }` (로그인 필요)
- `GET /api/credentials/status` (로그인 필요)
- `GET /api/upbit/accounts` (로그인 필요)
- `GET /api/upbit/all-balances` (로그인 필요)
- `GET /api/market/prices?symbols=BTC,ETH`
- `GET /api/upbit/open-orders` (로그인 필요)
- `GET /api/orders/history` (로그인 필요)
- `POST /api/pyramid/orders` (실거래 잠금 해제 및 명시적 확인 필요)
- `POST /api/orders/cancel-open` (실제 미체결 주문 취소 요청)

## 실거래 전 필수 검증

현재 UI와 서버 API는 아직 서로 연결되지 않았습니다. 서버 주문 엔드포인트는 첫 구현 단계이며 실계정에서 검증되지 않았습니다. 프런트엔드 로그인·키 등록·실시간 잔고·피라미드 주문 확인·주문 내역을 API에 연결하고, 테스트 계정에서 최소 주문/호가 단위/부분 체결/네트워크 타임아웃/취소 실패/중복 요청을 검증한 뒤에만 실거래를 검토하세요. 업비트의 주문이 체결된 경우 취소로 되돌릴 수 없습니다.
