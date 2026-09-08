package com.familyfinance.loan;
import java.time.LocalDate;
public record LoanPrepaymentRequest(String amount, LocalDate paidOn, String idempotencyKey, PrepaymentPlan plan) {
	public LoanPrepaymentRequest(String amount, LocalDate paidOn, String idempotencyKey) {
		this(amount, paidOn, idempotencyKey, PrepaymentPlan.SHORTEN_TERM);
	}
}
