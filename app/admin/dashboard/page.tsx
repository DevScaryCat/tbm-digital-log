"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
    LayoutDashboard, Users, Settings, LogOut, TrendingUp, AlertTriangle,
    Lightbulb, HardHat, Upload, CheckCircle2, Search, ArrowLeft,
    Loader2,
    Save
} from "lucide-react"
import { cn } from "@/lib/utils"

export default function AdminDashboardPage() {
    const router = useRouter()
    const [isLoading, setIsLoading] = useState(false)

    // 설정(Customization) 상태
    const [siteName, setSiteName] = useState("무신사 로지스틱스 1센터")
    const [logoPreview, setLogoPreview] = useState<string | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    // 통계용 가짜 데이터 (추후 Supabase DB 연동)
    const stats = {
        tbmRate: 85,
        tbmCount: 142,
        suggestions: { facility: 12, safety: 5 },
        patents: 3
    }

    // 로고 업로드 핸들러
    const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) {
            const reader = new FileReader()
            reader.onloadend = () => setLogoPreview(reader.result as string)
            reader.readAsDataURL(file)
        }
    }

    const handleSaveSettings = () => {
        setIsLoading(true)
        setTimeout(() => {
            setIsLoading(false)
            alert("현장 맞춤 설정이 저장되었습니다. 앱 전체에 적용됩니다.")
        }, 1000)
    }

    return (
        <div className="min-h-screen bg-slate-100 flex flex-col md:flex-row">

            {/* ----------------------------------------------------------- */}
            {/* 1. 사이드바 (데스크톱에서는 왼쪽, 모바일에서는 상단) */}
            {/* ----------------------------------------------------------- */}
            <div className="w-full md:w-64 bg-slate-900 text-white flex flex-col shadow-2xl z-20">
                <div className="p-6 flex items-center gap-3 border-b border-slate-800">
                    <div className="bg-orange-500 p-2 rounded-lg">
                        <HardHat className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="font-bold text-lg leading-tight">Admin Console</h1>
                        <p className="text-xs text-slate-400">TBM & 혁신 관리자</p>
                    </div>
                </div>

                <div className="flex-1 p-4 hidden md:flex flex-col gap-2">
                    {/* 데스크톱용 메뉴 안내 (모바일은 아래 Tabs로 처리) */}
                    <div className="text-sm font-medium text-slate-500 mb-2 px-2">관리 메뉴</div>
                    <Button variant="ghost" className="w-full justify-start text-white bg-slate-800"><LayoutDashboard className="mr-3 w-5 h-5" /> 대시보드</Button>
                    <Button variant="ghost" className="w-full justify-start text-slate-400 hover:text-white hover:bg-slate-800"><Users className="mr-3 w-5 h-5" /> 작업자 관리</Button>
                    <Button variant="ghost" className="w-full justify-start text-slate-400 hover:text-white hover:bg-slate-800"><Settings className="mr-3 w-5 h-5" /> 현장 설정</Button>
                </div>

                <div className="p-4 border-t border-slate-800 mt-auto flex gap-2">
                    <Button variant="ghost" onClick={() => router.push('/')} className="flex-1 text-slate-400 hover:text-white hover:bg-slate-800">
                        <ArrowLeft className="w-5 h-5 mr-2" /> 홈으로
                    </Button>
                    <Button variant="ghost" size="icon" className="text-slate-400 hover:text-white hover:bg-slate-800">
                        <LogOut className="w-5 h-5" />
                    </Button>
                </div>
            </div>

            {/* ----------------------------------------------------------- */}
            {/* 2. 메인 콘텐츠 영역 (모바일에 최적화된 Tabs 구조) */}
            {/* ----------------------------------------------------------- */}
            <div className="flex-1 p-4 md:p-8 overflow-y-auto">
                <div className="max-w-5xl mx-auto">

                    <Tabs defaultValue="dashboard" className="w-full">
                        {/* 모바일 최적화 탭 리스트 */}
                        <TabsList className="grid w-full grid-cols-3 mb-8 h-14 bg-white shadow-sm rounded-xl">
                            <TabsTrigger value="dashboard" className="text-base font-bold data-[state=active]:bg-slate-900 data-[state=active]:text-white rounded-lg transition-all">📊 통계</TabsTrigger>
                            <TabsTrigger value="users" className="text-base font-bold data-[state=active]:bg-slate-900 data-[state=active]:text-white rounded-lg transition-all">👥 인원</TabsTrigger>
                            <TabsTrigger value="settings" className="text-base font-bold data-[state=active]:bg-slate-900 data-[state=active]:text-white rounded-lg transition-all">⚙️ 설정</TabsTrigger>
                        </TabsList>

                        {/* ==========================================
                탭 1: 통계 대시보드 (Data Dashboard)
            ========================================== */}
                        <TabsContent value="dashboard" className="space-y-6 animate-in fade-in duration-500">
                            <h2 className="text-2xl font-extrabold text-slate-800">현장 통합 현황</h2>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {/* TBM 실시율 카드 */}
                                <Card className="border-0 shadow-md bg-gradient-to-br from-blue-500 to-blue-700 text-white">
                                    <CardContent className="p-6 relative overflow-hidden">
                                        <TrendingUp className="absolute -right-4 -bottom-4 w-32 h-32 opacity-20" />
                                        <p className="text-blue-100 font-medium mb-1">금일 TBM 실시율</p>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-5xl font-black">{stats.tbmRate}%</span>
                                            <span className="text-lg">({stats.tbmCount}건)</span>
                                        </div>
                                        {/* 프로그레스 바 */}
                                        <div className="w-full bg-blue-900/50 rounded-full h-3 mt-4">
                                            <div className="bg-white h-3 rounded-full" style={{ width: `${stats.tbmRate}%` }}></div>
                                        </div>
                                    </CardContent>
                                </Card>

                                {/* 제안함 현황 카드 */}
                                <Card className="border-0 shadow-md bg-white">
                                    <CardContent className="p-6">
                                        <p className="text-slate-500 font-medium mb-4">미해결 제안/민원</p>
                                        <div className="space-y-4">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <AlertTriangle className="w-5 h-5 text-red-500" />
                                                    <span className="font-bold text-slate-700">긴급 안전 위험</span>
                                                </div>
                                                <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full font-bold">{stats.suggestions.safety}건</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                                                    <span className="font-bold text-slate-700">일반 시설 민원</span>
                                                </div>
                                                <span className="bg-slate-100 text-slate-700 px-3 py-1 rounded-full font-bold">{stats.suggestions.facility}건</span>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>

                                {/* 특허 발굴 카드 */}
                                <Card className="border-0 shadow-md bg-gradient-to-br from-purple-600 to-indigo-800 text-white">
                                    <CardContent className="p-6 relative overflow-hidden">
                                        <Lightbulb className="absolute -right-4 -bottom-4 w-32 h-32 opacity-20" />
                                        <p className="text-purple-200 font-medium mb-1">이달의 특허 발굴 아이디어</p>
                                        <div className="flex items-baseline gap-2 mt-2">
                                            <span className="text-5xl font-black">{stats.patents}</span>
                                            <span className="text-lg">건</span>
                                        </div>
                                        <Button variant="secondary" className="w-full mt-5 bg-white/20 hover:bg-white/30 text-white border-0">
                                            보고서 확인하기
                                        </Button>
                                    </CardContent>
                                </Card>
                            </div>
                        </TabsContent>

                        {/* ==========================================
                탭 2: 작업자 및 소속 관리
            ========================================== */}
                        <TabsContent value="users" className="space-y-6 animate-in fade-in duration-500">
                            <Card className="shadow-md border-0">
                                <CardHeader className="bg-slate-50 border-b pb-4">
                                    <CardTitle>작업자 프로파일링</CardTitle>
                                    <CardDescription>현장 소속 인원 및 권한(관리자/반장/근로자) 관리</CardDescription>
                                </CardHeader>
                                <CardContent className="p-6">
                                    <div className="flex items-center gap-2 mb-6">
                                        <div className="relative flex-1">
                                            <Search className="absolute left-3 top-3 text-slate-400 w-5 h-5" />
                                            <Input placeholder="이름 또는 소속 업체명 검색" className="pl-10 h-12 text-lg bg-slate-50" />
                                        </div>
                                        <Button className="h-12 bg-slate-900 text-white px-6">검색</Button>
                                    </div>

                                    {/* 가짜 유저 리스트 */}
                                    <div className="border rounded-xl divide-y overflow-hidden">
                                        {[
                                            { name: "홍길동", role: "총괄 관리자", company: "무신사 로지스틱스", date: "2024.03.01" },
                                            { name: "김반장", role: "반장", company: "A 하청업체", date: "2024.03.15" },
                                            { name: "이작업", role: "근로자", company: "B 물류", date: "2024.03.20" },
                                        ].map((u, i) => (
                                            <div key={i} className="flex items-center justify-between p-4 hover:bg-slate-50">
                                                <div>
                                                    <div className="font-bold text-lg text-slate-800">{u.name}</div>
                                                    <div className="text-sm text-slate-500">{u.company} | 가입일: {u.date}</div>
                                                </div>
                                                <span className={cn(
                                                    "px-3 py-1 rounded-full text-sm font-bold border",
                                                    u.role === "총괄 관리자" ? "bg-red-50 text-red-600 border-red-200" :
                                                        u.role === "반장" ? "bg-blue-50 text-blue-600 border-blue-200" :
                                                            "bg-slate-100 text-slate-600 border-slate-200"
                                                )}>
                                                    {u.role}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        </TabsContent>

                        {/* ==========================================
                탭 3: 커스터마이징 (현장 설정)
            ========================================== */}
                        <TabsContent value="settings" className="space-y-6 animate-in fade-in duration-500">
                            <Card className="shadow-md border-0">
                                <CardHeader className="bg-slate-50 border-b pb-4">
                                    <CardTitle>현장 맞춤 설정</CardTitle>
                                    <CardDescription>앱 상단 로고 및 현장 서식을 업체에 맞게 변경합니다.</CardDescription>
                                </CardHeader>
                                <CardContent className="p-6 space-y-8">

                                    <div className="space-y-3">
                                        <Label className="text-base font-bold text-slate-700">현장명 (앱 상단 표기)</Label>
                                        <Input
                                            value={siteName}
                                            onChange={(e) => setSiteName(e.target.value)}
                                            className="h-14 text-lg border-slate-300 focus:ring-2 focus:ring-slate-900"
                                        />
                                    </div>

                                    <div className="space-y-3">
                                        <Label className="text-base font-bold text-slate-700">업체 로고 등록 (PDF 및 메인화면용)</Label>
                                        <div className="flex items-center gap-6">
                                            <div className="w-32 h-32 border-2 border-dashed border-slate-300 rounded-2xl flex items-center justify-center bg-slate-50 overflow-hidden">
                                                {logoPreview ? (
                                                    <img src={logoPreview} alt="Logo Preview" className="w-full h-full object-contain p-2" />
                                                ) : (
                                                    <span className="text-slate-400 text-sm">로고 없음</span>
                                                )}
                                            </div>
                                            <div className="space-y-2 flex-1">
                                                <input type="file" accept="image/*" ref={fileInputRef} className="hidden" onChange={handleLogoUpload} />
                                                <Button onClick={() => fileInputRef.current?.click()} variant="outline" className="h-12 border-slate-300">
                                                    <Upload className="w-4 h-4 mr-2" /> 이미지 업로드
                                                </Button>
                                                <p className="text-sm text-slate-500">
                                                    PNG, JPG 형식 지원 (가로형 로고 권장).<br />등록된 로고는 TBM PDF 출력물 상단에 찍힙니다.
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="pt-4 border-t">
                                        <Button
                                            onClick={handleSaveSettings}
                                            disabled={isLoading}
                                            className="w-full md:w-auto h-14 px-8 text-lg bg-slate-900 hover:bg-slate-800 text-white font-bold"
                                        >
                                            {isLoading ? <Loader2 className="animate-spin mr-2" /> : <Save className="mr-2" />}
                                            설정 저장 및 적용
                                        </Button>
                                    </div>

                                </CardContent>
                            </Card>
                        </TabsContent>

                    </Tabs>

                </div>
            </div>
        </div>
    )
}