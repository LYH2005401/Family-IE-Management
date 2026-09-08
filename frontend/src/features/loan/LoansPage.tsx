import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Button from "@douyinfe/semi-ui/lib/es/button";
import type {
  Account,
  Asset,
  Category,
  HouseholdRole,
  Loan,
  LoanInstallment,
  Member,
  Membership,
  Page,
} from "../../api/contracts";
import { ApiError } from "../../api/client";
import { businessDate, newIdempotencyKey } from "../../shared/runtime";
import {
  PaginationControls,
  readAllPages,
  usePageRecovery,
} from "../../shared/pagination";
import {
  DataPanel,
  Drawer,
  FormError,
  PageScaffold,
  QueryState,
  StatusTag,
  dateText,
  isManager,
  money,
  type RequestFn,
} from "../common";

export type LoanDraft = {
  name: string;
  type: "MORTGAGE" | "CAR" | "OTHER";
  linkedAssetId: string;
  createAssetFromLoan?: boolean;
  memberId: string;
  assignedUserId: string;
  paymentAccountId: string;
  paymentCategoryId: string;
  principal: string;
  annualRate: string;
  termMonths: string;
  repaymentMethod: "EQUAL_PAYMENT" | "EQUAL_PRINCIPAL" | "CUSTOM";
  startOn: string;
  customSchedule: Array<{ dueOn: string; principal: string; interest: string }>;
};

const ANNUAL_RATE_ERROR =
  "年利率请输入 0 到 100 之间的百分比，最多保留 4 位小数";

export function annualRatePercentError(raw: string): string | null {
  return /^(?:\d{1,2}(?:\.\d{1,4})?|100(?:\.0{1,4})?)$/.test(raw.trim())
    ? null
    : ANNUAL_RATE_ERROR;
}

function parseAnnualRatePercent(raw: string): number {
  const error = annualRatePercentError(raw);
  if (error) throw new Error(error);
  const [whole, decimal = ""] = raw.trim().split(".");
  const millionths = Number(whole) * 10_000 + Number(decimal.padEnd(4, "0"));
  return Number((millionths / 1_000_000).toFixed(6));
}

export function loanCreatePayload(value: LoanDraft) {
  return {
    ...value,
    linkedAssetId: value.linkedAssetId ? Number(value.linkedAssetId) : null,
    memberId: value.memberId ? Number(value.memberId) : null,
    assignedUserId: Number(value.assignedUserId),
    paymentAccountId: Number(value.paymentAccountId),
    paymentCategoryId: Number(value.paymentCategoryId),
    annualRate: parseAnnualRatePercent(value.annualRate),
    termMonths: Number(value.termMonths),
    customSchedule:
      value.repaymentMethod === "CUSTOM" ? value.customSchedule : null,
    createAssetFromLoan: value.createAssetFromLoan ?? false,
  };
}

export function formatAnnualRatePercent(raw: string): string {
  const value = Number(raw);
  return Number.isFinite(value)
    ? String(Number((value * 100).toFixed(4)))
    : raw;
}

export function LoansPage({
  request,
  role,
  userId = 0,
}: {
  request: RequestFn;
  role: HouseholdRole;
  userId?: number;
}) {
  const [selected, setSelected] = useState<Loan | null>(null);
  const [draft, setDraft] = useState<LoanDraft | null>(null);
  const [step, setStep] = useState(0);
  const [annualRateFeedback, setAnnualRateFeedback] = useState<string | null>(
    null,
  );
  const [prepay, setPrepay] = useState<{
    amount: string;
    paidOn: string;
    idempotencyKey: string;
    plan?: "SHORTEN_TERM" | "REDUCE_PAYMENT";
  } | null>(null);
  const [loanPage, setLoanPage] = useState(0);
  const [schedulePage, setSchedulePage] = useState(0);
  const loans = useQuery({
    queryKey: ["loans", "active-page", loanPage],
    queryFn: () =>
      request<Page<Loan>>(`/api/loans?status=ACTIVE&page=${loanPage}&size=50`, {
        responseType: "page",
      }),
  });
  const schedule = useQuery({
    queryKey: ["loan-schedule", selected?.id, schedulePage],
    queryFn: () =>
      request<Page<LoanInstallment>>(
        `/api/loans/${selected!.id}/schedule?page=${schedulePage}&size=50`,
        { responseType: "page" },
      ),
    enabled: selected !== null,
  });
  const accounts = useQuery({
    queryKey: ["accounts", "all-options"],
    queryFn: () =>
      readAllPages((page) =>
        request<Page<Account>>(`/api/accounts?page=${page}&size=50`, {
          responseType: "page",
        }),
      ),
  });
  const categories = useQuery({
    queryKey: ["categories", "flat-all-options"],
    queryFn: () =>
      readAllPages((page) =>
        request<Page<Category>>(
          `/api/categories?projection=flat&page=${page}&size=50`,
          { responseType: "page" },
        ),
      ),
  });
  const assets = useQuery({
    queryKey: ["assets", "active-all-options"],
    queryFn: () =>
      readAllPages((page) =>
        request<Page<Asset>>(`/api/assets?status=ACTIVE&page=${page}&size=50`, {
          responseType: "page",
        }),
      ),
  });
  const members = useQuery({
    queryKey: ["members"],
    queryFn: () => request<Member[]>("/api/members"),
  });
  const memberships = useQuery({
    queryKey: ["memberships", "all-options"],
    queryFn: () =>
      readAllPages((page) =>
        request<Page<Membership>>(
          `/api/family/memberships?page=${page}&size=50`,
          { responseType: "page" },
        ),
      ),
  });
  usePageRecovery(loanPage, loans.data, setLoanPage);
  usePageRecovery(schedulePage, schedule.data, setSchedulePage);
  const manager = isManager(role);
  const save = useMutation({
    mutationFn: (value: LoanDraft) =>
      request<Loan>("/api/loans", {
        method: "POST",
        body: loanCreatePayload(value),
      }),
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      const field = Object.keys(error.fields ?? {})[0];
      if (!field) return;
      if (["name", "type", "principal", "startOn"].includes(field)) setStep(0);
      else if (
        ["annualRate", "termMonths", "repaymentMethod"].includes(field) ||
        field.startsWith("customSchedule")
      )
        setStep(1);
      else setStep(2);
    },
    onSuccess: () => {
      setDraft(null);
      setStep(0);
    },
  });
  const confirm = useMutation({
    mutationFn: (id: number) =>
      request<LoanInstallment>(`/api/loan-installments/${id}/confirm`, {
        method: "POST",
      }),
  });
  const submitPrepay = useMutation({
    mutationFn: (value: NonNullable<typeof prepay>) =>
      request(`/api/loans/${selected!.id}/prepay`, {
        method: "POST",
        body: value,
      }),
    onSuccess: () => {
      setPrepay(null);
    },
  });
  const archive = useMutation({
    mutationFn: (id: number) =>
      request<void>(`/api/loans/${id}`, { method: "DELETE" }),
  });
  const blank = (): LoanDraft => ({
    name: "",
    type: "MORTGAGE",
    linkedAssetId: "",
    createAssetFromLoan: false,
    memberId: "",
    assignedUserId: "",
    paymentAccountId: "",
    paymentCategoryId: "",
    principal: "",
    annualRate: "",
    termMonths: "360",
    repaymentMethod: "EQUAL_PAYMENT",
    startOn: businessDate(),
    customSchedule: [],
  });
  const loanType = (value: Loan["type"]) =>
    value === "MORTGAGE" ? "房贷" : value === "CAR" ? "车贷" : "其他贷款";
  return (
    <PageScaffold
      title="贷款计划"
      primaryAction={
        manager
          ? {
              label: "新建贷款",
              onClick: () => {
                setDraft(blank());
                setStep(0);
                setAnnualRateFeedback(null);
              },
            }
          : undefined
      }
      readonly={!manager}
    >
      <FormError error={archive.error} />
      <div className="loan-summary" aria-label="贷款还款汇总">
        <span>
          计划还款总额{" "}
          <strong>
            {money(
              loans.data?.items
                .reduce(
                  (sum, item) =>
                    sum + Number(item.totalRepayment ?? item.principal),
                  0,
                )
                .toFixed(2),
            )}
          </strong>
        </span>
        <span>
          剩余还款总额{" "}
          <strong>
            {money(
              loans.data?.items
                .reduce(
                  (sum, item) =>
                    sum +
                    Number(item.remainingRepayment ?? item.currentPrincipal),
                  0,
                )
                .toFixed(2),
            )}
          </strong>
        </span>
      </div>
      <QueryState
        loading={loans.isLoading}
        error={loans.error}
        empty={!loans.data?.items.length && loanPage === 0}
        emptyTitle="还没有活跃贷款"
        emptyDetail={
          manager
            ? "创建贷款后即可查看每一期还款安排。"
            : "家庭目前没有需要查看的贷款。"
        }
      >
        <>
          <div className="loan-grid">
            {loans.data?.items.map((item) => (
              <article className="loan-card" key={item.id}>
                <header>
                  <div>
                    <StatusTag tone="blue">{loanType(item.type)}</StatusTag>
                    <h2>{item.name}</h2>
                  </div>
                  <span>
                    {item.repaymentMethod === "EQUAL_PAYMENT"
                      ? "等额本息"
                      : item.repaymentMethod === "EQUAL_PRINCIPAL"
                        ? "等额本金"
                        : "自定义"}
                  </span>
                </header>
                <div className="loan-principal">
                  <span>剩余本金</span>
                  <strong>{money(item.currentPrincipal)}</strong>
                </div>
                <dl className="loan-totals">
                  <div><dt>计划还款总额</dt><dd>{money(item.totalRepayment ?? item.principal)}</dd></div>
                  <div><dt>剩余还款总额</dt><dd>{money(item.remainingRepayment ?? item.currentPrincipal)}</dd></div>
                </dl>
                <dl>
                  <div>
                    <dt>原始本金</dt>
                    <dd>{money(item.principal)}</dd>
                  </div>
                  <div>
                    <dt>年利率</dt>
                    <dd>{formatAnnualRatePercent(item.annualRate)}%</dd>
                  </div>
                  <div>
                    <dt>期限</dt>
                    <dd>{item.termMonths} 个月</dd>
                  </div>
                  <div>
                    <dt>开始日</dt>
                    <dd>{dateText(item.startOn)}</dd>
                  </div>
                </dl>
                <footer>
                  <Button
                    size="small"
                    onClick={() => {
                      setSchedulePage(0);
                      setSelected(item);
                    }}
                  >
                    查看计划
                  </Button>
                  {manager && (
                    <>
                      <Button size="small" onClick={() => { const idempotencyKey = newIdempotencyKey(); setSelected(item); setPrepay({ amount: item.currentPrincipal, paidOn: businessDate(), idempotencyKey, plan: "SHORTEN_TERM" }); }}>一键结清</Button>
                      <Button
                        size="small"
                        onClick={() => {
                          const idempotencyKey = newIdempotencyKey();
                          setSelected(item);
                          setPrepay({
                            amount: "",
                            paidOn: businessDate(),
                            idempotencyKey,
                            plan: "SHORTEN_TERM",
                          });
                        }}
                      >
                        提前还款
                      </Button>
                      <button
                        className="text-action danger"
                        onClick={() => archive.mutate(item.id)}
                      >
                        归档
                      </button>
                    </>
                  )}
                </footer>
              </article>
            ))}
          </div>
          <PaginationControls
            page={loanPage}
            totalPages={loans.data?.totalPages ?? 0}
            hasNext={loans.data?.hasNext ?? false}
            onPageChange={setLoanPage}
            label="贷款"
          />
        </>
      </QueryState>
      <Drawer
        draft={draft}
        busy={save.isPending}
        onSessionStart={save.reset}
        open={draft !== null}
        title="新建贷款"
        description="三步填写合同；计划金额由服务器计算，确认前不会记账。"
        onClose={() => setDraft(null)}
      >
        {draft && (
          <>
            <ol className="wizard-steps" aria-label="贷款创建步骤">
              <li className={step >= 0 ? "active" : ""}>1 合同</li>
              <li className={step >= 1 ? "active" : ""}>2 还款</li>
              <li className={step >= 2 ? "active" : ""}>3 关联</li>
            </ol>
            <form
              className="feature-form"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                if (step === 1) {
                  const error = annualRatePercentError(draft.annualRate);
                  setAnnualRateFeedback(error);
                  if (error) {
                    const field = e.currentTarget.elements.namedItem(
                      "annualRate",
                    ) as HTMLElement | null;
                    field?.focus();
                    field?.scrollIntoView?.({ block: "nearest" });
                    return;
                  }
                }
                if (step < 2) setStep(step + 1);
                else save.mutate(draft);
              }}
            >
              <FormError error={save.error} scopeKey={step} />
              {step === 0 && (
                <>
                  <label>
                    贷款名称
                    <input
                      name="name"
                      required
                      value={draft.name}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    贷款类型
                    <select
                      name="type"
                      value={draft.type}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          type: e.target.value as LoanDraft["type"],
                        })
                      }
                    >
                      <option value="MORTGAGE">房贷</option>
                      <option value="CAR">车贷</option>
                      <option value="OTHER">其他</option>
                    </select>
                  </label>
                  <label>
                    本金
                    <input
                      name="principal"
                      required
                      inputMode="decimal"
                      value={draft.principal}
                      onChange={(e) =>
                        setDraft({ ...draft, principal: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    开始日期
                    <input
                      name="startOn"
                      required
                      type="date"
                      value={draft.startOn}
                      onChange={(e) =>
                        setDraft({ ...draft, startOn: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {step === 1 && (
                <>
                  <label>
                    年利率（%）
                    <input
                      aria-label="年利率（%）"
                      name="annualRate"
                      required
                      inputMode="decimal"
                      aria-invalid={annualRateFeedback ? true : undefined}
                      aria-describedby={
                        annualRateFeedback ? "annual-rate-error" : undefined
                      }
                      value={draft.annualRate}
                      onChange={(e) => {
                        const annualRate = e.target.value;
                        setDraft({ ...draft, annualRate });
                        if (annualRateFeedback)
                          setAnnualRateFeedback(
                            annualRatePercentError(annualRate),
                          );
                      }}
                    />
                  </label>
                  {annualRateFeedback && (
                    <span
                      id="annual-rate-error"
                      className="field-help"
                      role="alert"
                    >
                      {annualRateFeedback}
                    </span>
                  )}
                  <label>
                    期限（月）
                    <input
                      name="termMonths"
                      required
                      type="number"
                      min="1"
                      value={draft.termMonths}
                      onChange={(e) =>
                        setDraft({ ...draft, termMonths: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    还款方式
                    <select
                      name="repaymentMethod"
                      value={draft.repaymentMethod}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          repaymentMethod: e.target
                            .value as LoanDraft["repaymentMethod"],
                        })
                      }
                    >
                      <option value="EQUAL_PAYMENT">等额本息</option>
                      <option value="EQUAL_PRINCIPAL">等额本金</option>
                      <option value="CUSTOM">自定义计划</option>
                    </select>
                  </label>
                  {draft.repaymentMethod === "CUSTOM" ? (
                    <fieldset data-field="customSchedule" tabIndex={-1}>
                      <legend>自定义期次</legend>
                      {draft.customSchedule.map((row, index) => (
                        <div className="custom-installment" key={index}>
                          <input
                            aria-label={`第 ${index + 1} 期日期`}
                            required
                            type="date"
                            name={`customSchedule[${index}].dueOn`}
                            value={row.dueOn}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                customSchedule: draft.customSchedule.map(
                                  (item, i) =>
                                    i === index
                                      ? { ...item, dueOn: e.target.value }
                                      : item,
                                ),
                              })
                            }
                          />
                          <input
                            aria-label={`第 ${index + 1} 期本金`}
                            required
                            placeholder="本金"
                            name={`customSchedule[${index}].principal`}
                            value={row.principal}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                customSchedule: draft.customSchedule.map(
                                  (item, i) =>
                                    i === index
                                      ? { ...item, principal: e.target.value }
                                      : item,
                                ),
                              })
                            }
                          />
                          <input
                            aria-label={`第 ${index + 1} 期利息`}
                            required
                            placeholder="利息"
                            name={`customSchedule[${index}].interest`}
                            value={row.interest}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                customSchedule: draft.customSchedule.map(
                                  (item, i) =>
                                    i === index
                                      ? { ...item, interest: e.target.value }
                                      : item,
                                ),
                              })
                            }
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                customSchedule: draft.customSchedule.filter(
                                  (_, i) => i !== index,
                                ),
                              })
                            }
                          >
                            移除
                          </button>
                        </div>
                      ))}
                      <Button
                        type="tertiary"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            customSchedule: [
                              ...draft.customSchedule,
                              { dueOn: "", principal: "", interest: "" },
                            ],
                          })
                        }
                      >
                        添加期次
                      </Button>
                    </fieldset>
                  ) : (
                    <div className="source-note">
                      创建后自动生成每期本金与利息，确认还款后才会记账。
                    </div>
                  )}
                </>
              )}
              {step === 2 && (
                <>
                  <label>
                    关联资产
                    <select
                      name="linkedAssetId"
                      value={draft.linkedAssetId}
                      onChange={(e) =>
                        setDraft({ ...draft, linkedAssetId: e.target.value })
                      }
                    >
                      <option value="">不关联</option>
                      {assets.data?.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(draft.type === "MORTGAGE" || draft.type === "CAR") && <label className="checkbox-row"><input type="checkbox" checked={draft.createAssetFromLoan ?? false} onChange={(e) => setDraft({ ...draft, createAssetFromLoan: e.target.checked })} />本次贷款购买物（自动新建资产）</label>}
                  <label>
                    归属成员
                    <select
                      name="memberId"
                      value={draft.memberId}
                      onChange={(e) =>
                        setDraft({ ...draft, memberId: e.target.value })
                      }
                    >
                      <option value="">家庭共有</option>
                      {members.data?.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    确认还款人
                    <select
                      name="assignedUserId"
                      required
                      value={draft.assignedUserId}
                      onChange={(e) =>
                        setDraft({ ...draft, assignedUserId: e.target.value })
                      }
                    >
                      <option value="">请选择</option>
                      {memberships.data?.map((item) => (
                        <option key={item.userId} value={item.userId}>
                          {item.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    扣款账户
                    <select
                      name="paymentAccountId"
                      required
                      value={draft.paymentAccountId}
                      onChange={(e) =>
                        setDraft({ ...draft, paymentAccountId: e.target.value })
                      }
                    >
                      <option value="">请选择</option>
                      {accounts.data?.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    还款分类
                    <select
                      name="paymentCategoryId"
                      required
                      value={draft.paymentCategoryId}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          paymentCategoryId: e.target.value,
                        })
                      }
                    >
                      <option value="">请选择支出分类</option>
                      {categories.data
                        ?.filter((item) => item.kind === "expense")
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              <div className="form-footer">
                {step > 0 && (
                  <Button onClick={() => setStep(step - 1)}>上一步</Button>
                )}
                <Button
                  htmlType="submit"
                  theme="solid"
                  type="primary"
                  loading={save.isPending}
                >
                  {step < 2 ? "下一步" : "创建并生成计划"}
                </Button>
              </div>
            </form>
          </>
        )}
      </Drawer>
      <Drawer
        sessionKey={selected?.id}
        busy={confirm.isPending}
        onSessionStart={confirm.reset}
        open={selected !== null && prepay === null}
        title={`${selected?.name ?? ""} · 还款计划`}
        description="到期后可确认本期还款；如需提前偿还本金，请使用贷款卡片上的「提前还款」。"
        onClose={() => {
          setSelected(null);
          setSchedulePage(0);
        }}
      >
        <FormError error={confirm.error} />
        <QueryState
          loading={schedule.isLoading}
          error={schedule.error}
          empty={!schedule.data?.items.length && schedulePage === 0}
          emptyTitle="计划尚未生成"
        >
          <>
            <div className="schedule-list">
              {schedule.data?.items.map((item) => (
                <article
                  key={item.id}
                  className={item.status !== "PENDING" ? "settled" : ""}
                >
                  <div>
                    <b>{String(item.installmentNo).padStart(2, "0")}</b>
                    <span>{dateText(item.dueOn)}</span>
                  </div>
                  <dl>
                    <span>
                      本金 <strong>{money(item.principal)}</strong>
                    </span>
                    <span>
                      利息 <strong>{money(item.interest)}</strong>
                    </span>
                  </dl>
                  {item.status === "PAID" ? (
                    <StatusTag tone="success">已支付</StatusTag>
                  ) : item.status === "CANCELLED" ? (
                    <StatusTag>已取消</StatusTag>
                  ) : item.dueOn > businessDate() ? (
                    <StatusTag>未到期</StatusTag>
                  ) : selected?.assignedUserId === userId ? (
                    <Button
                      size="small"
                      loading={confirm.isPending}
                      onClick={() => confirm.mutate(item.id)}
                    >
                      确认还款
                    </Button>
                  ) : (
                    <StatusTag tone="warning">待确认</StatusTag>
                  )}
                </article>
              ))}
            </div>
            <PaginationControls
              page={schedulePage}
              totalPages={schedule.data?.totalPages ?? 0}
              hasNext={schedule.data?.hasNext ?? false}
              onPageChange={setSchedulePage}
              label="还款计划"
            />
          </>
        </QueryState>
      </Drawer>
      <Drawer
        draft={prepay}
        sessionKey={selected?.id}
        busy={submitPrepay.isPending}
        onSessionStart={submitPrepay.reset}
        open={prepay !== null}
        title={`${selected?.name ?? ""} · 提前还款`}
        description={`当前剩余本金 ${money(selected?.currentPrincipal)}；服务器会重排未来计划并保留已还历史。`}
        onClose={() => {
          setPrepay(null);
          setSelected(null);
        }}
      >
        {prepay && (
          <form
            className="feature-form"
            onSubmit={(e) => {
              e.preventDefault();
              submitPrepay.mutate(prepay);
            }}
          >
            <FormError error={submitPrepay.error} />
            <label>
              提前还款金额
              <input
                required
                inputMode="decimal"
                name="amount"
                value={prepay.amount}
                onChange={(e) =>
                  setPrepay({ ...prepay, amount: e.target.value })
                }
              />
            </label>
            <label>
              还款日期
              <input
                required
                type="date"
                name="paidOn"
                value={prepay.paidOn}
                onChange={(e) =>
                  setPrepay({ ...prepay, paidOn: e.target.value })
                }
              />
            </label>
            <label>
              提前还款后的计划
              <select value={prepay.plan ?? "SHORTEN_TERM"} onChange={(e) => setPrepay({ ...prepay, plan: e.target.value as "SHORTEN_TERM" | "REDUCE_PAYMENT" })}>
                <option value="SHORTEN_TERM">缩短还款年限，月供尽量保持不变</option>
                <option value="REDUCE_PAYMENT">减少月供，还款期限不变</option>
              </select>
            </label>
            <div className="source-note">
              填写全部剩余本金即可结清，已完成的还款记录会保留。
            </div>
            <Button
              htmlType="submit"
              theme="solid"
              type="primary"
              loading={submitPrepay.isPending}
            >
              确认提前还款
            </Button>
          </form>
        )}
      </Drawer>
    </PageScaffold>
  );
}
