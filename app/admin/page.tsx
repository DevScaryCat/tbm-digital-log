"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card"
import { Loader2, CheckCircle, Send, Lock } from "lucide-react"

export default function AdminPage() {
    // 인증 상태
    const [isAuthenticated, setIsAuthenticated] = useState(false)
    const [secretKey, setSecretKey] = useState("")

    // 입력 폼
    const [form, setForm] = useState({ siteName: "", managerEmail: "", desiredId: "" })
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<any>(null)

    // 1. 관리자 비밀번호 확인 (간이 인증)
    const handleLogin = (e: React.FormEvent) => {
        e.preventDefault()
        if (secretKey) {
            setIsAuthenticated(true)
        }
    }

    // 2. 계정 생성 요청
    const handleCreate = async () => {
        if (!form.siteName || !form.managerEmail || !form.desiredId) {
            alert("모든 정보를 입력해주세요.")
            return
        }

        setLoading(true)
        setResult(null)

        try {
            // 랜덤 비밀번호 생성
            const randomPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-2);

            // 아이디 조합 (@tbm.com)
            const fullEmailId = `${form.desiredId}@tbm.com`

            // 서버로 보낼 데이터 구성
            const payload = {
                email: fullEmailId,
                password: randomPassword,
                name: form.siteName,
                company: form.siteName,
                managerEmail: form.managerEmail // 담당자 이메일 필수
            }

            const res = await fetch('/api/admin/create', {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-secret-key': secretKey
                }
            })
            const data = await res.json()

            if (res.status === 401) {
                alert("관리자 비밀번호가 틀렸습니다.")
                setIsAuthenticated(false)
                return
            }

            if (data.success) {
                setResult({
                    userId: fullEmailId,
                    password: randomPassword
                })
                alert("계정이 생성되고 메일이 발송되었습니다! ✅")
            } else {
                alert("실패: " + (data.error || "알 수 없는 오류"))
            }
        } catch (e) {
            console.error(e)
            alert("서버 통신 오류가 발생했습니다.")
        } finally {
            setLoading(false)
        }
    }

    // --- 로그인 화면 ---
    if (!isAuthenticated) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-900 p-4">
                <Card className="w-full max-w-sm border-0 shadow-2xl">
                    <CardHeader className="text-center pb-2">
                        <div className="mx-auto bg-slate-100 p-3 rounded-full w-fit mb-4">
                            <Lock className="w-8 h-8 text-slate-900" />
                        </div>
                        <CardTitle>관리자 접근 제한</CardTitle>
                        <CardDescription>마스터 키를 입력하세요.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleLogin} className="space-y-4">
                            <Input
                                type="password"
                                placeholder="Admin Password"
                                value={secretKey}
                                onChange={(e) => setSecretKey(e.target.value)}
                                className="text-center h-12 text-lg"
                            />
                            <Button type="submit" className="w-full h-12 bg-slate-900 hover:bg-slate-800">
                                접속하기
                            </Button>
                        </form>
                    </CardContent>
                </Card>
            </div>
        )
    }

    // --- 생성 폼 화면 ---
    return (
        <div className="min-h-screen p-8 bg-slate-100 flex justify-center items-start">
            <Card className="w-full max-w-lg border-2 border-slate-200 shadow-xl">
                <CardHeader className="bg-slate-50 border-b">
                    <CardTitle className="flex items-center gap-2">
                        👷 현장 계정 발급
                    </CardTitle>
                    <CardDescription>현장 정보를 입력하면 계정이 자동 생성됩니다.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                    <div className="space-y-2">
                        <Label className="font-bold">현장명 (업체명)</Label>
                        <Input
                            placeholder="예: 무신사 로지스틱스 1센터"
                            value={form.siteName}
                            onChange={e => setForm({ ...form, siteName: e.target.value })}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="font-bold">담당자 이메일 (계정 받을 곳)</Label>
                        <Input
                            type="email"
                            placeholder="manager@naver.com"
                            value={form.managerEmail}
                            onChange={e => setForm({ ...form, managerEmail: e.target.value })}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="font-bold">희망 아이디</Label>
                        <div className="flex items-center gap-2">
                            <Input
                                placeholder="예: site01"
                                value={form.desiredId}
                                onChange={e => setForm({ ...form, desiredId: e.target.value })}
                            />
                        </div>
                    </div>

                    <Button onClick={handleCreate} disabled={loading} className="w-full h-12 bg-orange-600 hover:bg-orange-700 text-white text-lg font-bold shadow-md">
                        {loading ? <Loader2 className="animate-spin" /> : <><Send className="w-5 h-5 mr-2" /> 계정 생성 및 전송</>}
                    </Button>

                    {result && (
                        <div className="mt-6 p-6 bg-green-50 text-green-800 rounded-lg border border-green-200 shadow-sm animate-in fade-in slide-in-from-bottom-2">
                            <div className="font-bold flex items-center gap-2 text-xl mb-4 text-green-700">
                                <CheckCircle className="w-6 h-6" /> 발급 완료
                            </div>
                            <div className="space-y-1 text-lg">
                                <div className="flex justify-between border-b border-green-200 pb-1">
                                    <span className="font-medium">아이디:</span>
                                    <span className="font-bold select-all">{result.userId}</span>
                                </div>
                                <div className="flex justify-between pt-1">
                                    <span className="font-medium">비밀번호:</span>
                                    <span className="font-bold select-all">{result.password}</span>
                                </div>
                            </div>
                            <p className="text-sm text-green-600 mt-4 text-center">
                                * 담당자 이메일({form.managerEmail})로 전송되었습니다.
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}