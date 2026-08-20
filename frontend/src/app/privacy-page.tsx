import {Link, Outlet} from '@tanstack/react-router';
import {ArrowLeft, ShieldCheck} from 'lucide-react';
import {DashboardFooter} from './shell/DashboardFooter';

const SERVICE_URL = 'https://jungle-bell.sijun-yang.com';

const purposes = [
    {
        title: '계정 관리',
        description: '회원 가입 및 관리, PC 앱 설치 등록, 연결된 기기와 계정의 생성·관리·삭제',
    },
    {
        title: '서비스 제공',
        description: '출석·세탁·식단 콘텐츠 제공, PC·모바일 연결, 알림 기능 제공',
    },
    {
        title: '통계 분석',
        description: '서비스 방문과 정해진 기능의 이용 현황 분석 및 서비스 개선',
    },
] as const;

const detailedRetention = [
    '일반 웹·연결 전 PWA의 방문자 단위 사용 기록: 2일',
    '연결된 PWA·PC 앱의 사용자별 화면 활동 기록: 7일',
    '사용자별 기능 이용 기록: 30일',
    '개인을 다시 식별하기 위한 값이 없는 일별 집계 결과: 최대 730일',
] as const;

function PolicySection({id, title, children}: {id: string; title: string; children: React.ReactNode}) {
    return (
        <section className="mt-10 space-y-4" aria-labelledby={id}>
            <h2 id={id} className="text-xl font-semibold">{title}</h2>
            {children}
        </section>
    );
}

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
                    <h1 className="mt-4 text-3xl font-bold tracking-tight">개인정보 처리방침</h1>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        Jungle Bell(
                        <a href={SERVICE_URL} className="font-medium text-foreground underline-offset-4 hover:underline">
                            {SERVICE_URL}
                        </a>
                        )은 정보주체의 자유와 권리 보호를 위해 「개인정보 보호법」 및 관계 법령이 정한 바를 준수하여 개인정보를 적법하게 처리하고 안전하게 관리합니다.
                    </p>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        「개인정보 보호법」 제30조에 따라 개인정보의 처리와 보호에 관한 절차 및 기준을 안내하고, 관련 고충을 신속하고 원활하게 처리할 수 있도록 다음과 같이 개인정보 처리방침을 수립·공개합니다.
                    </p>
                    <p className="mt-3 text-xs font-medium text-muted-foreground">
                        시행일: 2026-08-20 <span aria-hidden="true">|</span> 버전: 1.0
                    </p>
                </header>

                <PolicySection id="processing-purpose-title" title="1. 개인정보의 처리 목적">
                    <p className="text-sm leading-6 text-muted-foreground">
                        Jungle Bell은 다음의 목적을 위하여 개인정보를 처리합니다.
                    </p>
                    <dl className="divide-y rounded-xl border bg-card px-5">
                        {purposes.map((purpose) => (
                            <div key={purpose.title} className="py-4 first:pt-5 last:pb-5">
                                <dt className="font-semibold">{purpose.title}</dt>
                                <dd className="mt-1 text-sm leading-6 text-muted-foreground">{purpose.description}</dd>
                            </div>
                        ))}
                    </dl>
                </PolicySection>

                <PolicySection id="collected-data-title" title="2. 수집하는 개인정보 항목">
                    <div className="rounded-xl border bg-card p-5">
                        <h3 className="font-semibold">필수 항목</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">없음</p>
                        <h3 className="mt-5 font-semibold">자동 수집 항목</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            IP 주소, 쿠키, 기기정보, 서비스 이용기록
                        </p>
                        <h3 className="mt-5 font-semibold">수집 방법</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            제3자 제공, 쿠키(Cookie), IP 주소, 자체 서버의 웹 로그 분석, 기기정보 수집 및 이용 패턴 분석
                        </p>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">
                        사용 통계에는 Web·PWA·Desktop 구분, 화면 열림 여부와 서버에서 성공이 확인된 정해진 기능의 이용 횟수만 기록합니다. 24시간 방문자 쿠키 원문과 IP 주소는 사용 통계 데이터베이스에 저장하지 않으며, PostHog와 Google Analytics 같은 외부 분석 도구를 사용하지 않습니다.
                    </p>
                </PolicySection>

                <PolicySection id="retention-title" title="3. 개인정보의 보유 기간 및 파기">
                    <div className="rounded-xl border bg-card p-5">
                        <h3 className="font-semibold">보유 기간</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            기본 보유기간: 회원 탈퇴 또는 연결 계정 삭제 시까지
                        </p>
                        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
                            {detailedRetention.map((retention) => (
                                <li key={retention}>{retention}</li>
                            ))}
                        </ul>
                    </div>
                    <div className="rounded-xl border bg-card p-5">
                        <h3 className="font-semibold">파기 절차 및 방법</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            파기 사유가 발생한 개인정보를 선정하고 개인정보 보호책임자의 승인을 받아 지체 없이 파기합니다.
                        </p>
                        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
                            <li>전자파일: 복구할 수 없도록 완전 삭제하며, 필요한 경우 덮어쓰기 방식으로 파기합니다.</li>
                            <li>종이문서: 원칙적으로 생성하지 않으며, 생성된 경우 분쇄기로 분쇄합니다.</li>
                        </ul>
                    </div>
                </PolicySection>

                <PolicySection id="security-title" title="4. 개인정보의 안전성 확보조치">
                    <dl className="rounded-xl border bg-card p-5">
                        <dt className="font-semibold">관리적 조치</dt>
                        <dd className="mt-2 text-sm leading-6 text-muted-foreground">내부관리계획 수립·시행</dd>
                        <dt className="mt-5 font-semibold">기술적 조치</dt>
                        <dd className="mt-2 text-sm leading-6 text-muted-foreground">
                            개인정보 암호화, 접근 권한 제한, 인증 토큰과 주요 식별값의 해시 처리
                        </dd>
                    </dl>
                </PolicySection>

                <PolicySection id="rights-title" title="5. 정보주체의 권리·의무 및 행사방법">
                    <p className="text-sm leading-6 text-muted-foreground">
                        정보주체는 개인정보 열람, 정정·삭제, 처리정지 및 동의 철회를 요구할 수 있습니다. 권리 행사와 개인정보 관련 고충은 이메일로 접수합니다.
                    </p>
                    <p className="text-sm leading-6 text-muted-foreground">
                        공개 이슈에는 개인정보를 적지 마세요. 구체적인 이메일 연락처와 개인정보 보호책임자 정보는 정식 서비스 공개 전에 이 페이지에 추가합니다.
                    </p>
                    <a
                        href="https://github.com/YangSiJun528/jungle-bell"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                        프로젝트 문의 경로 보기
                    </a>
                </PolicySection>

                <PolicySection id="changes-title" title="6. 개인정보 처리방침의 변경">
                    <p className="text-sm leading-6 text-muted-foreground">
                        이 개인정보 처리방침은 2026-08-20부터 적용됩니다.
                    </p>
                    <p className="text-sm leading-6 text-muted-foreground">변경 고지 방법: 앱 내 공지</p>
                </PolicySection>
            </main>
            <DashboardFooter/>
        </div>
    );
}
