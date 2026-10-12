# Sprint — Coaching Tool (bản PO sửa lại)

> Bản này thay thế sprint gốc "Interview Research Tool (coach-only)".
> PO: Giang · Viết lại sau khi verify hạ tầng thực tế trong repo.

---

## 1. Định vị lại sản phẩm

Sprint gốc mô tả một tool sinh tài liệu phỏng vấn. Sau khi làm rõ với PO, mục tiêu
thật rộng hơn và **người dùng chính là coach (Vi), không phải học viên**:

> Giải quyết nỗi khổ của Vi khi chuẩn bị cho mỗi buổi coaching — hiện đang làm tay:
> đọc lại CV học viên, google công ty, đọc JD, nghĩ câu hỏi, nghĩ 60 phút sẽ nói gì.

Đây là **hai sản phẩm**, không phải một:

| | Học viên (membership) | Vi (admin) |
|---|---|---|
| Làm gì | Book buổi coaching, gom context | Chuẩn bị & chạy buổi coaching |
| Tốn LLM | Không (hoặc rất ít) | Có — toàn bộ pipeline nặng |
| Thấy gì | Bản rút gọn **sau khi Vi duyệt** | Toàn bộ |

**Gate:** tool Coaching là **admin-only** (`is_admin = true`). Học viên chỉ chạm được
màn book và bản rút gọn sau duyệt.

---

## 2. Luồng tổng thể

```
HỌC VIÊN (membership)         HỆ THỐNG                      VI (admin)
─────────────────────         ────────                      ──────────
① Book coaching        ─────▶ ② STAGE 0: Context Readiness
   · loại buổi                   (gom DB + Exa, ~0 token)
   · JD (text/URL) *bắt buộc          │
   · công ty / vòng / người PV        ├─ 🟢 đủ ──────────▶ ④ Review pack
   · "điều em lo nhất"                │                      trong Console
   · ☑ tích context có sẵn            └─ 🟡🔴 thiếu ─────▶ ③ CONTEXT DESK
   · đề xuất 2–3 khung giờ                                    · bổ sung URL/CV/JD
        │                                                     · 📝 ghi chú coach
        │                                                     · [Gen pack]
        │                                    ┌────────────────────┘
        │                                    ▼
        │                          ③b 4 bước LLM (async job)
        │                                    │
        │                                    ▼
⑦ Xem bản rút gọn + tải  ◀───────────── ⑤ Sửa · gen lại · Duyệt
⑧ "Luyện thử" → Interview Lab                    │
   (questionBank đã duyệt)                       ▼
                                        ⑥ Sau buổi: notes + action items
```

---

## 3. Prep-pack gồm những gì

Mỗi phần tương ứng một việc Vi đang làm tay:

| Vi phải làm tay | Pack tự sinh |
|---|---|
| Đọc lại CV, nhớ học viên là ai | **① Hồ sơ 1 trang** — HV là ai, đã dùng tool gì, mạnh/yếu, buổi trước nói gì |
| Google công ty ~30 phút | **② Company brief có nguồn** (Exa + Jina + Companies House) |
| Đọc JD, đối chiếu CV | **③ Bảng fit** — JD đòi gì ↔ HV có gì ↔ thiếu gì ↔ chỗ interviewer sẽ soi |
| Nghĩ câu hỏi sẽ bị hỏi | **④ 15–20 câu** theo vòng + người PV, gợi ý trả lời lấy từ chính bullet CV của HV |
| Nghĩ 60 phút này nói gì | **⑤ Agenda buổi coaching có chia phút** ⭐ *(sprint gốc thiếu)* |
| Ghi chú sau buổi, nhắc việc | **⑥ Notes + action items** ⭐ *(sprint gốc thiếu)* |

⑤ mới là nỗi khổ thật nhất — sprint gốc chỉ giải quyết "có tài liệu", chưa giải quyết
"buổi coaching chạy thế nào". ⑥ biến tool từ *máy sinh tài liệu một lần* thành *hệ
thống quản lý coaching*: buổi sau tự có context buổi trước.

---

## 4. Quyết định đã chốt

| # | Vấn đề | Chốt |
|---|---|---|
| 1 | Role coach | Dùng `is_admin` sẵn có. Không thêm role mới. |
| 2 | Tính phí | **Không dùng ví credit.** Thêm `users.coaching_credits` (membership = 1, admin cấp thêm tay từ `/admin/users`). Credit đo token; coaching đo **thời gian của Vi** — trộn hai loại tài nguyên vào một ví sẽ luôn mâu thuẫn. |
| 3 | Booking | Học viên đề xuất 2–3 khung giờ → Vi xác nhận trong Console. **Không** xây slot engine, **không** nhúng Calendly (nhúng ngoài thì context không chảy vào tool được). |
| 4 | Xuất file | Print CSS + `window.print()`. Repo không có thư viện sinh PDF (`pdf-parse` chỉ để đọc). |
| 5 | Nguồn CV | `cv_versions` là **nguồn duy nhất**. Ưu tiên: CV Library active → CV Optimizer gần nhất → upload tại form book. |
| 6 | Bảng chết | `company_research_reports`, `interview_packs`, `question_bank_entries`, `job_rubrics`, `rubric_templates` — có trong migration 001, **0 file code dùng**. Không tái dùng, dọn ở ticket riêng. |
| 7 | Gen pack | **Async job** (`202 + jobId`, poll) như CV Optimizer. Chạy đồng bộ chắc chắn timeout. |
| 8 | `session_type` | Thêm cột ngay từ đầu (`interview_prep` \| `cv_review` \| `career_direction`), Phase 1 chỉ implement `interview_prep`. |

---

## 5. Hạ tầng đã verify

### Tái dùng được ngay
- `parseDreamCompanyCv` — `backend/src/services/dream-company.service.ts:304`
- `generateProfileAnalysis` — `:114`
- `backend/src/lib/companies-house.ts` (commit `bc69547`) — ⚠️ key optional, chỉ có dữ liệu UK
- `lib/exa-client.ts` (Exa), Jina qua outreach
- `extract-job-from-url` (interview-prep) — dùng cho ô JD
- `answer_assessments` — IRS scores + `missing_signals_json` từng câu
- questionBank (commits `1d4e907`, `7847a41`) — nền cho T7
- Async job pattern: `cv_analysis_jobs` + `createCvAnalysisJob` / `getCvAnalysisJob`
- Admin UI: `app/admin/users`, `app/admin/leads`

### Lỗ hổng dữ liệu phải vá TRƯỚC (ticket T0)

**a) `cv_analysis_jobs` không lưu input**
```js
// cv-optimizer.service.ts:882
.insert({ user_id: userId, status: 'queued' })
```
Có `result_json` nhưng không biết phân tích CV nào, role gì, JD nào.
→ Thêm cột `input_json` (`targetRole`, `jobDescription`, `cv_version_id`).

**b) Dream Company không lưu `ProfileAnalysis`**
State giữ hoàn toàn ở client (`profile` + `analysis` + `selectedRoles` gửi lại mỗi hop).
`tool_results` chỉ ghi roadmap → mất `marketLevel`, `coreStrengths`, `criticalGaps`,
`uniqueValueProposition`, `readinessScore` — đúng thứ Vi cần nhất.
→ Ghi `{ v: 2, profile, analysis, selectedRoles, roadmap }`. 0 LLM call thêm.
⚠️ **Phải versioned**: History screen replay `result` để render; row cũ không có `v`
thì đọc như roadmap thuần, nếu không sẽ vỡ lịch sử cũ.

**c) Dream Company / CV Optimizer nhận CV rồi vứt**
→ Cả hai ghi/link vào `cv_versions`.

**d) `tool_results.tool` là check constraint `('cv','dream','interview')`**
→ Thêm `'coaching'`. Cap 512KB/row vẫn dư.

**e) Outreach không lưu gì** → bỏ qua Phase 1.

### Luật chung rút ra
> Mỗi lần chạy tool lưu **cả input lẫn output**, và luôn trỏ về `cv_versions` khi có CV.

---

## 6. Tickets

| # | Ticket | Est | Phụ thuộc |
|---|---|---|---|
| **T0** | **Vá dữ liệu**: `cv_analysis_jobs.input_json` · DC lưu `analysis` (versioned) · link `cv_versions` · thêm `'coaching'` vào enum | **1d** | — |
| T1 | Bảng `coaching_sessions` + RLS. Cột: `student_id`, `created_by`, `session_type`, `company_name`, `company_url`, `jd_text`, `stage`, `interviewer_role`, `worry_text`, `context_refs jsonb`, `coach_notes`, `generated_pack jsonb`, `session_notes jsonb`, `scheduled_at`, `status` (`draft`\|`context_needed`\|`generating`\|`failed`\|`ready`\|`approved`\|`done`). Thêm `users.coaching_credits` | 0.5d | T0 |
| T2 | Form book + **Context Picker** (đọc `cv_versions` / `tool_results` / `cv_analysis_jobs`) + đề xuất khung giờ. Gate `membership` + trừ `coaching_credits` | 1.5d | T1 |
| T2.5 | **Calendar view** `/admin/coaching` (CSS grid, không thư viện) + mini-list "Buổi của tôi" cho HV | 0.5d | T1 |
| T3 | **Company Research** grounded + cited: Exa → Jina → Companies House → Sonnet. Sparse → gắn cờ + liệt kê "cần bổ sung", **không viết văn cho đủ** | 2d | — (song song) |
| T3.5 | **STAGE 0 — Context Readiness**: chấm điểm context, 🟢 tự gen / 🟡🔴 đẩy vào Context Desk | 0.5d | T2, T3 |
| T4 | **Orchestrator async job** — 4 bước Sonnet sinh 6 phần của pack (mục 3). Log cost | 2d | T3.5 |
| T5 | **Coaching Console**: Context Desk (bổ sung URL/CV/JD + ghi chú coach) + battlecard (sửa · gen-lại-1-câu · khó/dễ · bỏ · thêm tay · ⭐) + Duyệt → khoá | 2d | T4 |
| T6 | Bản học viên read-only + xuất file (print CSS) | 1d | T5 |
| T6.5 | Notes + action items sau buổi | 0.5d | T5 |
| **Tổng Phase 1** | | **~11.5d** | |

### Phase 2
- **T7** — 1-Click Mock: mở Interview Lab với `questionBank` = câu đã duyệt + điểm yếu HV. Kết quả lưu về case → `done`. (1d)
- **T8** — (tuỳ chọn) Interviewer Intelligence + câu trả lời mẫu STAR.

### Thứ tự
```
T0 → T1 → T2 → T2.5 ─┐
                     ├→ T3.5 → T4 → T5 → T6 → T6.5   [Phase 1]
T3 (song song) ──────┘                     └→ T7 → T8 [Phase 2]
```

---

## 7. Chênh lệch với sprint gốc

| Sprint gốc | Bản này | Vì sao |
|---|---|---|
| 6.5–9d | ~11.5d | Thêm T0 (vá dữ liệu), Context Picker, async job, agenda, notes |
| Gen đồng bộ lúc book | Async job | 4 LLM + Exa + Jina chắc chắn > 120s (Dream Company 4 LLM đã phải để 120s) |
| 10 credit | `coaching_credits` riêng | Membership = 20 credit → 10 cho ra 2 lần, không phải 1. Mà 20 thì HV hết sạch credit, không chạy nổi tool tạo context cho chính buổi coaching |
| "mentorship tier" | `membership` | Tier chỉ có `trial` \| `membership` (migration 015) |
| "admin/coach" | `is_admin` | Không tồn tại role coach |
| Lưu `tool_results` ở T4 | Bỏ | Pack đã ở `coaching_sessions.generated_pack`; hai nguồn sự thật |
| Pack 4 phần | 6 phần | Thêm agenda buổi + notes sau buổi |
| — | STAGE 0 + Context Desk | Chặn gen khi context mỏng: tránh pack rác + tiết kiệm LLM |
| — | Calendar view | PO yêu cầu |

---

## 8. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| **T3 hallucinate** | Grounded + cited bắt buộc: LLM chỉ được dùng text đã fetch, mỗi claim gắn `sourceUrl`, không có nguồn → drop. Bài học `docs/JOB_SOURCE_RUNBOOK.md` |
| **Companies House** chỉ UK, key optional | Set `COMPANIES_HOUSE_API_KEY` trên Railway trước khi test T3. Công ty ngoài UK → luôn `sparse` |
| **T5 dễ đội** | Nếu trễ, cắt "gen-lại-1-câu" trước; giữ sửa tay + xoá + thêm |
| **Cost Sonnet** | Chấp nhận (volume thấp) nhưng log qua `cost-tracker.ts`. STAGE 0 chặn bớt lượt gen phí |
| **Attach doc** | Text/URL only. Repo có luật cứng: không blob storage, artifact chỉ nhận `{ text }` |
| **Rate limit** | Bắt buộc opt-in mỗi route LLM. Đề xuất: gen pack 3/giờ/user, regen-1-câu 10/phút/user |
