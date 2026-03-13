# 랜덤 여행 앱 — 작업 현황

## 프로젝트 개요
- **목표**: 위치 기반 랜덤 여행 계획 웹앱
- **배포**: Vercel
- **스택**: Vite + React + TypeScript
- **원본 참고**: `D:/android_project/random_travel.tsx` (Claude Artifacts용 단일 컴포넌트)

---

## 완료된 작업

### 1. 프로젝트 세팅
| 파일 | 상태 | 설명 |
|------|------|------|
| `package.json` | ✅ 완료 | react, vite, typescript 의존성 |
| `vite.config.ts` | ✅ 완료 | Vite + React 플러그인 설정 |
| `tsconfig.json` | ✅ 완료 | TypeScript 설정 |
| `tsconfig.app.json` | ✅ 완료 | 앱 전용 TS 설정 |
| `index.html` | ✅ 완료 | 엔트리 HTML (모바일 최적화 meta 포함) |
| `vercel.json` | ✅ 완료 | Vercel 배포 설정 |
| `node_modules/` | ✅ 완료 | npm install 완료 |

### 2. 소스 코드
| 파일 | 상태 | 설명 |
|------|------|------|
| `src/main.tsx` | ✅ 완료 | React 엔트리 포인트 |
| `src/App.tsx` | ✅ 완료 | 메인 앱 컴포넌트 (전체 UI + 로직) |
| `src/utils/geo.ts` | ✅ 완료 | 위치 계산 유틸리티 |
| `src/data/korea.ts` | ✅ 완료 | 한국 행정구역 + 여행지 데이터 (516줄) |

### 3. 위치 계산 유틸 (`src/utils/geo.ts`) — 구현 완료
- Haversine 거리 계산 (두 좌표 간 km)
- 참가자 중심점(centroid) 계산
- 이동수단별 최대/최소 반경 정의
- 전국 교통 허브 48개 (공항/역/터미널/항구) 좌표 데이터
- 최적 집합장소 알고리즘 (참가자→허브 거리 합 최소화)
- 이동수단별 목적지 필터링
- 예상 소요시간 계산
- 방위각 계산 (북/남/동/서)

### 4. 앱 UI/로직 (`src/App.tsx`) — 구현 완료
- **홈 화면**: "여행 준비" / "이미 여행지" 모드 선택
- **출발지 입력**: 시/도 → 시/군/구 → 읍/면/동 **선택식** UI (기존 텍스트 입력 제거)
- **여행 설정**: 이동수단 복수 선택, 기간, 출발 시간
- **계획 생성**: 위치 기반 최적 집합장소 + 랜덤 목적지 로직
- **결과 화면**: 수단/집합장소/목적지/거리/소요시간 표시 + 카카오맵 연동
- **여행 모드**: GPS 기반 음식/카페/관광지/액티비티/다음동네 룰렛
- **스핀 결과**: 거리/방향/평점 표시 + 카카오맵 길찾기

---

## 미완료 작업 (TODO)

### 🔴 필수 — 모두 완료! ✅ 빌드 성공 (234KB)

---

### 🟡 선택 (있으면 좋은 것)

#### 2. GPS 기반 실제 장소 연동
- 현재: 카테고리별 고정 풀에서 랜덤 ("현지 시장 국밥", "루프탑 뷰 카페" 등)
- 개선안: Kakao Local API 연동하여 실제 주변 가게/장소 검색
- 필요: Kakao REST API Key

#### 3. 지도 시각화
- 참가자 위치, 집합장소, 목적지를 지도 위에 표시
- 필요: Kakao Maps JavaScript API Key

#### 4. 여행 계획 저장/공유
- ✅ localStorage에 이전 여행 기록 저장 (스핀 기록 + 여행 계획 기록)
- ✅ 계획 결과 공유 기능 추가 (Web Share API, 미지원 시 클립보드 복사 fallback)

#### 5. 더 정교한 집합장소 로직
- 현재: 교통 허브 48개 중 거리 합 최소
- 개선안: 실제 대중교통 경로/시간 기반 최적화 (API 필요)

#### 6. 모바일 PWA 지원
- manifest.json, service worker 추가
- 홈 화면에 추가 가능하게

---

## 빌드 & 배포 방법 (데이터 파일 완성 후)

```bash
# 로컬 개발
cd D:/android_project/random-travel
npm run dev

# 빌드
npm run build

# Vercel 배포
npx vercel          # 첫 배포
npx vercel --prod   # 프로덕션 배포
```

---

## 파일 구조
```
random-travel/
├── package.json          ✅
├── package-lock.json     ✅
├── vite.config.ts        ✅
├── tsconfig.json         ✅
├── tsconfig.app.json     ✅
├── index.html            ✅
├── vercel.json           ✅
├── node_modules/         ✅
└── src/
    ├── main.tsx          ✅
    ├── App.tsx           ✅ (41KB, ~500줄)
    ├── utils/
    │   └── geo.ts        ✅ (교통허브 48개 + 위치 계산 함수들)
    └── data/
        └── korea.ts      ✅ (516줄, 17시도/230+시군구/1000+읍면동/100여행지)
```

---

## 핵심 설계 결정사항
1. **좌표는 시/군/구 단위** — 동 단위 좌표는 불필요 (여행 계획에서 구 내 차이는 미미)
2. **집합장소 = 교통허브 최적화** — 참가자→허브 거리 합이 최소인 허브 선택
3. **목적지 필터링 = 이동수단 반경** — 비행기 600km, 기차 350km, 자가용 200km 등
4. **여행 모드 = GPS + 랜덤 풀** — 실제 API 없이도 동작, 카카오맵 검색으로 연결
