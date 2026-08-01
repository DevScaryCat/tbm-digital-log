// 카카오 OAuth는 신규 가입과 재로그인이 같은 버튼이라 "시작 화면 / 로그인 화면" 분리가 성립하지 않는다.
// 명함·카카오톡 공유·검색 유입에 이 주소가 남아 있어 파일은 두고 정본(/login)으로만 넘긴다.
import { redirect } from "next/navigation"

export default function StartPage() {
    redirect("/login")
}
