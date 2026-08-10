# Markdown 사이트 빌드하기

이 패키지는 별도 Worker를 배포하지 않습니다. Astro가 `site/dist`에 정적 파일을 만든 뒤 루트 빌드가 해당 파일을 앱 Worker의 `dist/blog`와 `dist/blog-assets`에 합칩니다.

## 소식 추가

`src/content/posts`에 Markdown 파일을 추가하고 기존 글과 동일한 frontmatter 필드를 작성합니다. 글 목록과 JSON, RSS는 빌드 시 자동으로 생성됩니다.

## 통합 빌드

저장소 루트에서 다음 명령을 실행합니다.

```sh
npm run build
```

운영 canonical URL과 RSS origin은 기본값을 사용합니다. 테스트 Worker용 자산을 빌드할 때만 공개 origin을 명시합니다.

```sh
JUNGLE_BELL_PUBLIC_ORIGIN=https://jungle-bell-api-test.example.workers.dev npm run build
```

`JUNGLE_BELL_PUBLIC_ORIGIN`에는 경로가 없는 HTTPS origin을 입력합니다. 이 값은 빌드 결과에 포함되므로 환경별 CI에서 해당 환경의 공개 주소를 설정해야 합니다.
