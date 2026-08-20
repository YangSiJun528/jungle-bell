import {Link, Outlet} from '@tanstack/react-router';
import {ArrowLeft, ShieldCheck} from 'lucide-react';
import {DashboardFooter} from './shell/DashboardFooter';

const items = [
    {
        title: '일반 웹·연결 전 PWA',
        description: '접속 날짜, Web/PWA 구분, 화면 열림 여부, 24시간 방문자 쿠키를 날짜별 HMAC으로 바꾼 값만 기록합니다. 쿠키 원문은 서버 DB에 저장하지 않습니다.',
        retention: '방문자 단위 원자료 2일',
    },
    {
        title: '연결된 PWA·PC 앱',
        description: '서버 내부 사용자 UUID, PWA/Desktop 구분, 화면 열림 여부를 기록합니다. PC 앱의 백그라운드 실행 상태는 실제 화면 사용과 별도로 취급합니다.',
        retention: '사용자별 화면 활동 7일',
    },
    {
        title: '기능 사용',
        description: '서버에서 성공이 확인된 출석·식단 알림 설정 변경, 세탁 알림 생성·취소, 모바일 연결·해제, 푸시 구독·해제 횟수만 정해진 코드로 기록합니다.',
        retention: '사용자별 기능 원자료 30일',
    },
] as const;

export function PublicRouteOutlet() {
    return <Outlet/>;
}

export function PrivacyPage() {
    return (
        <div className="flex min-h-svh flex-col bg-background text-foreground">
            <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
                <Link
                    to="/home"
                    className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft className="size-4" aria-hidden="true"/>
                    대시보드로 돌아가기
                </Link>
                <header className="mt-8 border-b pb-8">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <ShieldCheck className="size-6" aria-hidden="true"/>
                    </div>
                    <h1 className="mt-4 text-3xl font-bold tracking-tight">개인정보 처리 안내</h1>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        Jungle Bell은 개인 운영 지원 도구입니다. 서비스 운영과 기능 개선에 필요한 최소 사용량을 자체 PostgreSQL에 집계하며 PostHog와 Google Analytics는 사용하지 않습니다.
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">시행일: 2026년 8월 20일</p>
                </header>

                <section className="mt-8 space-y-4" aria-labelledby="collected-data-title">
                    <h2 id="collected-data-title" className="text-xl font-semibold">수집하는 사용 기록</h2>
                    {items.map((item) => (
                        <article key={item.title} className="rounded-xl border bg-card p-5">
                            <h3 className="font-semibold">{item.title}</h3>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
                            <p className="mt-3 text-xs font-medium text-foreground">보관: {item.retention}</p>
                        </article>
                    ))}
                    <p className="text-sm leading-6 text-muted-foreground">
                        일별 활성 사용자 수·기능별 사용자 수·사용 횟수처럼 개인을 다시 식별하기 위한 값이 없는 집계 결과는 최대 730일 보관합니다.
                    </p>
                </section>

                <section className="mt-10 space-y-3" aria-labelledby="excluded-data-title">
                    <h2 id="excluded-data-title" className="text-xl font-semibold">사용 통계에 넣지 않는 정보</h2>
                    <p className="text-sm leading-6 text-muted-foreground">
                        이름, 이메일, 전화번호, LMS 계정·쿠키, 출석 내용, 식단 내용, 세탁기 입력값, 접속 URL, 검색어, 임의 이벤트 속성은 사용 통계 테이블에 저장하지 않습니다. 인증·알림 등 기능 제공에 필요한 계정 및 세션 데이터는 각 기능의 동작과 보안을 위해 별도로 처리됩니다.
                    </p>
                </section>

                <section className="mt-10 space-y-3" aria-labelledby="processing-title">
                    <h2 id="processing-title" className="text-xl font-semibold">처리 위치와 외부 인프라</h2>
                    <p className="text-sm leading-6 text-muted-foreground">
                        사용 통계는 Jungle Bell 서버의 PostgreSQL에서 처리하며 분석 업체로 전송하지 않습니다. 다만 웹 요청과 일반 접속 로그는 서비스 제공 과정에서 Cloudflare 네트워크를 경유할 수 있으며, 호스팅·네트워크 사업자의 보안 및 운영 정책에 따라 IP 주소 같은 접속 정보가 별도로 처리될 수 있습니다.
                    </p>
                </section>

                <section className="mt-10 space-y-3" aria-labelledby="contact-title">
                    <h2 id="contact-title" className="text-xl font-semibold">삭제·문의</h2>
                    <p className="text-sm leading-6 text-muted-foreground">
                        연결된 계정 삭제나 처리 내용 문의는 프로젝트 운영자에게 요청할 수 있습니다. 공개 이슈에는 개인정보를 적지 마세요.
                    </p>
                    <a
                        href="https://github.com/YangSiJun528/jungle-bell"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                        프로젝트 문의 경로 보기
                    </a>
                </section>
            </main>
            <DashboardFooter/>
        </div>
    );
}
