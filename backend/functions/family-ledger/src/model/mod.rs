//! The ledger's items, as `backend/docs/dynamodb-schema.md` lays them out.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::rules::exact::Exact;
use crate::rules::money::{Currency, RecordedRates};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Meal,
    Parents,
    Gift,
    Other,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Meal => "meal",
            Self::Parents => "parents",
            Self::Gift => "gift",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitMode {
    Equal,
    Percent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Transfer,
    Cash,
    Other,
}

/// What every saved ledger item carries about the write that last changed it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    #[serde(default)]
    pub rev: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_request_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expense {
    #[serde(skip)]
    pub id: String,
    pub title: String,
    pub kind: Kind,
    pub group_id: String,
    pub payer_id: String,
    pub added_by: String,
    pub amount_minor: i64,
    pub currency: Currency,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_amount_minor: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_currency: Option<Currency>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charged_currency: Option<Currency>,
    /// The day the expense was entered. It orders the debts and never changes.
    pub date: String,
    /// The day the money was spent, chosen by the member. Absent only on items saved before it
    /// existed, which read it as `date`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_date: Option<String>,
    pub split_mode: SplitMode,
    pub participant_ids: Vec<String>,
    pub shares: BTreeMap<String, i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percents: Option<BTreeMap<String, i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorded_rates: Option<RecordedRates>,
    pub recorded_at: String,
    pub version: u64,
    pub seq: u64,
    #[serde(flatten)]
    pub stamp: Stamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payment {
    #[serde(skip)]
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub paid_minor: i64,
    pub paid_currency: Currency,
    pub credited_minor: i64,
    pub credited_currency: Currency,
    pub method: Method,
    /// The day the payment was entered. It never changes.
    pub date: String,
    /// The day the money was given, chosen by the member. Absent only on items saved before it
    /// existed, which read it as `date`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorded_rates: Option<RecordedRates>,
    pub recorded_by: String,
    pub recorded_at: String,
    /// Payments saved before they could be edited are at version 1.
    #[serde(default = "first_version")]
    pub version: u64,
    pub seq: u64,
    #[serde(flatten)]
    pub stamp: Stamp,
}

fn first_version() -> u64 {
    1
}

impl Expense {
    /// The day the money was spent.
    pub fn transaction_date(&self) -> &str {
        self.transaction_date.as_deref().unwrap_or(&self.date)
    }
}

impl Payment {
    /// The day the money was given.
    pub fn transaction_date(&self) -> &str {
        self.transaction_date.as_deref().unwrap_or(&self.date)
    }
}

/// One expense's open debt between two members, signed from the lower member's point of view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Debt {
    pub expense_id: String,
    pub group_id: String,
    pub date: String,
    pub seq: u64,
    pub currency: Currency,
    pub gross_minor: i64,
    pub remaining_minor: i64,
    /// Only meaningful while an event is being applied. A closed debt then leaves the list.
    #[serde(skip)]
    pub closed: bool,
}

/// Money a payment left over, signed like a debt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credit {
    pub payment_id: String,
    pub seq: u64,
    pub amount_minor: i64,
    pub currency: Currency,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(with = "exact_text")]
    pub applied_total: Exact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Newest {
    pub date: String,
    pub seq: u64,
    pub group_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub currency: Currency,
    pub amount_minor: i64,
}

/// What a payment covered on one expense.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationSlice {
    pub expense_id: String,
    pub payment_id: String,
    pub from_id: String,
    pub to_id: String,
    pub paid_minor: i64,
    pub paid_currency: Currency,
    pub covered_minor: i64,
    pub method: Method,
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    #[serde(skip)]
    pub id: String,
    pub display_name: String,
    pub home_currency: Currency,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    pub email: String,
    pub created_at: String,
    #[serde(flatten)]
    pub stamp: Stamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    #[serde(skip)]
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub member_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usual_split: Option<BTreeMap<String, i64>>,
    pub version: u64,
    pub seq: u64,
    #[serde(flatten)]
    pub stamp: Stamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateEntry {
    #[serde(skip)]
    pub id: String,
    pub usd_cad: String,
    pub cad_clp: String,
    pub date: String,
    pub entered_by: String,
    pub seq: u64,
    #[serde(flatten)]
    pub stamp: Stamp,
}

impl RateEntry {
    pub fn recorded(&self) -> RecordedRates {
        RecordedRates {
            usd_cad: self.usd_cad.clone(),
            cad_clp: self.cad_clp.clone(),
        }
    }
}

/// The stored form of a pair of members' state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairItem {
    pub balances: Vec<Balance>,
    pub open_debts: Vec<Debt>,
    pub credits: Vec<Credit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_debt: Option<Newest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationItem {
    pub allocations: Vec<AllocationSlice>,
}

/// One line of a group's list of expenses, by group or by group and kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseEntry {
    pub expense_id: String,
    pub title: String,
    pub kind: Kind,
    pub group_id: String,
    pub payer_id: String,
    pub added_by: String,
    pub amount_minor: i64,
    pub currency: Currency,
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_date: Option<String>,
    pub participant_ids: Vec<String>,
    /// How the expense is split, copied from it. Absent on entries saved before entries carried
    /// shares, until `backfill-list-entries` runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_mode: Option<SplitMode>,
    /// Each participant's share in minor units, copied from the expense. Absent like `split_mode`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shares: Option<BTreeMap<String, i64>>,
    /// The percentages of a percent split, copied from the expense.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percents: Option<BTreeMap<String, i64>>,
    pub seq: u64,
}

impl ExpenseEntry {
    pub fn transaction_date(&self) -> &str {
        self.transaction_date.as_deref().unwrap_or(&self.date)
    }
}

impl From<&Expense> for ExpenseEntry {
    fn from(expense: &Expense) -> Self {
        Self {
            expense_id: expense.id.clone(),
            title: expense.title.clone(),
            kind: expense.kind,
            group_id: expense.group_id.clone(),
            payer_id: expense.payer_id.clone(),
            added_by: expense.added_by.clone(),
            amount_minor: expense.amount_minor,
            currency: expense.currency,
            date: expense.date.clone(),
            transaction_date: expense.transaction_date.clone(),
            participant_ids: expense.participant_ids.clone(),
            split_mode: Some(expense.split_mode),
            shares: Some(expense.shares.clone()),
            percents: expense.percents.clone(),
            seq: expense.seq,
        }
    }
}

/// One line of the list of payments between two members.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentEntry {
    pub payment_id: String,
    pub from_id: String,
    pub to_id: String,
    pub paid_minor: i64,
    pub paid_currency: Currency,
    pub credited_minor: i64,
    pub credited_currency: Currency,
    pub method: Method,
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default = "first_version")]
    pub version: u64,
    pub seq: u64,
}

impl PaymentEntry {
    pub fn transaction_date(&self) -> &str {
        self.transaction_date.as_deref().unwrap_or(&self.date)
    }
}

impl From<&Payment> for PaymentEntry {
    fn from(payment: &Payment) -> Self {
        Self {
            payment_id: payment.id.clone(),
            from_id: payment.from_id.clone(),
            to_id: payment.to_id.clone(),
            paid_minor: payment.paid_minor,
            paid_currency: payment.paid_currency,
            credited_minor: payment.credited_minor,
            credited_currency: payment.credited_currency,
            method: payment.method,
            date: payment.date.clone(),
            transaction_date: payment.transaction_date.clone(),
            group_id: payment.group_id.clone(),
            version: payment.version,
            seq: payment.seq,
        }
    }
}

mod exact_text {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    use crate::rules::exact::{self, Exact};

    pub fn serialize<S: Serializer>(value: &Exact, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&exact::to_text(value))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Exact, D::Error> {
        let text = String::deserialize(deserializer)?;
        exact::from_text(&text).ok_or_else(|| D::Error::custom("not a stored fraction"))
    }
}
