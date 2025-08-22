# RAW PCM 파형 탐색기

React 기반의 RAW PCM 오디오 파일 분석 및 재생 도구입니다.

## 🎵 기능

- **다양한 PCM 포맷 지원**: 8u, 16le/be, 24le/be, 32le, 32f, µ-law, A-law
- **실시간 파형 시각화**: 파형 썸네일과 상세 파형 보기
- **필터링 시스템**: 무음/평탄, 과도한 클리핑, 스케일 이상 파일 자동 필터링
- **오디오 재생**: 조정 가능한 샘플레이트로 실시간 재생
- **WAV 내보내기**: 분석된 파일을 WAV 형식으로 다운로드

## 🚀 시작하기

### 사전 요구사항

- Node.js 18.0 이상
- npm 또는 yarn

### 설치 및 실행

```bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev

# 프로덕션 빌드
npm run build

# 프리뷰 서버 실행
npm run preview
```

## 📁 사용법

1. `.pcm` 또는 `.raw` 파일을 업로드합니다
2. 가정 샘플레이트를 설정합니다 (파형 표시용)
3. 필터 옵션을 조정합니다
4. 분석 결과에서 적절한 포맷을 선택합니다
5. 카드를 클릭하여 상세 정보 및 재생 기능을 사용합니다

## 🛠 기술 스택

- **Frontend**: React 18, TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **Audio Processing**: Web Audio API, Canvas API

## 📄 라이선스

MIT License
