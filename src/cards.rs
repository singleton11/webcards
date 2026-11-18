use super::*;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Content {
    pub russian: String,
    pub english: String,
    pub sense: String,
    pub context: String,
    pub note: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    request_id: Uuid,
    content: Content,
    source: String,
    model: String,
    prompt_version: String,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Command {
    Edit {
        #[serde(rename = "requestId")]
        request_id: Uuid,
        revision: i32,
        content: Content,
    },
    Archive {
        #[serde(rename = "requestId")]
        request_id: Uuid,
        revision: i32,
    },
    Restore {
        #[serde(rename = "requestId")]
        request_id: Uuid,
        revision: i32,
    },
    Delete {
        #[serde(rename = "requestId")]
        request_id: Uuid,
        revision: i32,
    },
    Reset {
        #[serde(rename = "requestId")]
        request_id: Uuid,
        revision: i32,
    },
    Undo {
        #[serde(rename = "requestId")]
        request_id: Uuid,
        revision: i32,
        #[serde(rename = "saveRequestId")]
        save_request_id: Uuid,
    },
}
impl Command {
    fn base(&self) -> (Uuid, i32) {
        match self {
            Self::Edit {
                request_id,
                revision,
                ..
            }
            | Self::Archive {
                request_id,
                revision,
            }
            | Self::Restore {
                request_id,
                revision,
            }
            | Self::Delete {
                request_id,
                revision,
            }
            | Self::Reset {
                request_id,
                revision,
            }
            | Self::Undo {
                request_id,
                revision,
                ..
            } => (*request_id, *revision),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Card {
    pub id: Uuid,
    pub status: String,
    pub revision: i32,
    pub version: i32,
    pub content: Content,
    pub source: String,
    pub model: String,
    pub prompt_version: String,
    pub created_at: String,
    pub updated_at: String,
}
const SELECT: &str = "SELECT c.id,c.status,c.revision,c.current_version AS version,c.original_source AS source,c.model,c.prompt_version,c.created_at,c.updated_at,json_build_object('russian',v.russian,'english',v.english,'sense',v.sense,'context',v.context,'note',v.note) AS content FROM cards c JOIN card_versions v ON v.card_id=c.id AND v.version=c.current_version";
const VALIDATION: &str =
    "Check both language sides, meaning and context, or reload the card and try again.";
pub(crate) fn normalize(text: &str) -> String {
    text.nfc()
        .collect::<String>()
        .split(is_js_space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn is_js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub(crate) fn len(text: &str) -> usize {
    text.encode_utf16().count()
}
pub(crate) fn clean(text: &str, max: usize, required: bool) -> Result<String> {
    let s = normalize(text);
    if (required && s.is_empty()) || len(&s) > max || s.contains('\0') {
        return Err(validation(VALIDATION));
    }
    Ok(s)
}
impl Content {
    fn validate(&mut self) -> Result<()> {
        self.russian = clean(&self.russian, 1000, true)?;
        self.english = clean(&self.english, 1000, true)?;
        self.sense = clean(&self.sense, 160, true)?;
        self.context = clean(&self.context, 300, false)?;
        self.note = clean(&self.note, 300, false)?;
        Ok(())
    }
    fn search(&self) -> String {
        format!(
            "{} {} {} {} {}",
            self.russian, self.english, self.sense, self.context, self.note
        )
        .to_lowercase()
    }
}
fn fingerprint(c: &Content) -> String {
    hex::encode(Sha256::digest(
        json!([c.russian, c.english, c.sense, c.context]).to_string(),
    ))
}
fn from_row(r: sqlx::postgres::PgRow) -> Result<Card> {
    Ok(Card {
        id: r.try_get("id")?,
        status: r.try_get("status")?,
        revision: r.try_get("revision")?,
        version: r.try_get("version")?,
        content: serde_json::from_value(r.try_get("content")?).map_err(|_| internal())?,
        source: r.try_get("source")?,
        model: r.try_get("model")?,
        prompt_version: r.try_get("prompt_version")?,
        created_at: iso(r.try_get("created_at")?),
        updated_at: iso(r.try_get("updated_at")?),
    })
}
async fn get(c: &mut PgConnection, owner: &str, id: Uuid) -> Result<Option<Card>> {
    sqlx::query(&format!("{SELECT} WHERE c.owner_id=$1 AND c.id=$2"))
        .bind(owner)
        .bind(id)
        .fetch_optional(c)
        .await?
        .map(from_row)
        .transpose()
}
async fn duplicate(
    c: &mut PgConnection,
    owner: &str,
    fp: &str,
    except: Option<Uuid>,
) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar("SELECT id FROM cards WHERE owner_id=$1 AND fingerprint=$2 AND status='active' AND ($3::uuid IS NULL OR id<>$3)").bind(owner).bind(fp).bind(except).fetch_optional(c).await?)
}
async fn write_version(
    c: &mut PgConnection,
    id: Uuid,
    version: i32,
    v: &Content,
    origin: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO card_versions(card_id,version,russian,english,sense,context,note,search_text,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(id).bind(version).bind(&v.russian).bind(&v.english).bind(&v.sense).bind(&v.context).bind(&v.note).bind(v.search()).bind(origin).execute(c).await?;
    Ok(())
}
pub(crate) async fn handler(
    app: Arc<App>,
    id: Option<String>,
    request: Request,
) -> Result<Response> {
    method_allowed(request.method(), &[Method::GET, Method::POST])?;
    if request.method() != Method::GET {
        app.check_origin(request.headers())?
    }
    let owner = app
        .owner(request.headers())
        .await?
        .ok_or_else(|| {
            ApiError::new(
                401,
                "unauthorized",
                "Please sign in again to access your vocabulary.",
            )
        })?
        .user_id;
    let id = id
        .map(|s| Uuid::parse_str(&s).map_err(|_| not_found()))
        .transpose()?;
    if request.method() == Method::GET {
        if let Some(id) = id {
            let mut c = app.db.acquire().await?;
            return Ok(json_response(
                json!({"card":get(&mut c,&owner,id).await?.ok_or_else(not_found)?}),
            ));
        }
        let query: HashMap<String, String> = request
            .uri()
            .query()
            .map(|q| {
                url::form_urlencoded::parse(q.as_bytes())
                    .into_owned()
                    .collect()
            })
            .unwrap_or_default();
        if query
            .keys()
            .any(|s| !matches!(s.as_str(), "q" | "page" | "status"))
        {
            return Err(validation(VALIDATION));
        }
        let q = clean(query.get("q").map(String::as_str).unwrap_or(""), 100, false)?.to_lowercase();
        let status = query.get("status").map(String::as_str).unwrap_or("active");
        if !matches!(status, "active" | "archived") {
            return Err(validation(VALIDATION));
        }
        let page = query
            .get("page")
            .map(|s| s.parse::<i32>())
            .unwrap_or(Ok(1))
            .map_err(|_| validation(VALIDATION))?;
        if !(1..=100000).contains(&page) {
            return Err(validation(VALIDATION));
        }
        let filter =
            " WHERE c.owner_id=$1 AND c.status=$2 AND ($3='' OR strpos(v.search_text,$3)>0)";
        let rows = sqlx::query(&format!(
            "{SELECT}{filter} ORDER BY c.created_at DESC,c.id LIMIT 50 OFFSET $4"
        ))
        .bind(&owner)
        .bind(status)
        .bind(&q)
        .bind((page - 1) * 50)
        .fetch_all(&app.db)
        .await?;
        let total:i64=sqlx::query_scalar(&format!("SELECT count(*) FROM cards c JOIN card_versions v ON v.card_id=c.id AND v.version=c.current_version{filter}")).bind(&owner).bind(status).bind(q).fetch_one(&app.db).await?;
        let cards: Vec<Card> = rows.into_iter().map(from_row).collect::<Result<_>>()?;
        return Ok(json_response(
            json!({"cards":cards,"total":total,"page":page,"pageSize":50}),
        ));
    }
    let raw = read_json(request, 16384).await?;
    let (request_id, payload, save, command) = if let Some(id) = id {
        let mut command: Command =
            serde_json::from_value(raw).map_err(|_| validation(VALIDATION))?;
        if command.base().1 <= 0 {
            return Err(validation(VALIDATION));
        }
        if let Command::Edit { content, .. } = &mut command {
            content.validate()?
        }
        let payload = legacy_command(id, &command);
        (command.base().0, payload, None, Some(command))
    } else {
        let mut save: Save = serde_json::from_value(raw).map_err(|_| validation(VALIDATION))?;
        save.content.validate()?;
        if !matches!(save.source.as_str(), "ru" | "en")
            || !matches!(save.model.as_str(), model::MODEL | model::LEGACY_MODEL)
            || save.prompt_version.is_empty()
            || save.prompt_version.len() > 80
            || !save
                .prompt_version
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        {
            return Err(validation(VALIDATION));
        }
        let payload = legacy_save(&save);
        (save.request_id, payload, Some(save), None)
    };
    let mut tx = app.transaction(&owner).await?;
    let mut mac = Hmac::<Sha256>::new_from_slice(app.secret.as_bytes()).map_err(|_| internal())?;
    mac.update(b"webcards-card-receipt-v1\0");
    mac.update(payload.as_bytes());
    let hash = hex::encode(mac.finalize().into_bytes());
    let receipt = sqlx::query("SELECT * FROM card_receipts WHERE owner_id=$1 AND request_id=$2")
        .bind(&owner)
        .bind(request_id)
        .fetch_optional(&mut *tx)
        .await?;
    let (card_id, outcome, revision) = if let Some(r) = receipt {
        if r.try_get::<String, _>("payload_hash")? != hash {
            return Err(ApiError::new(
                409,
                "request_conflict",
                "This request ID was already used for another change.",
            ));
        }
        (
            r.try_get("card_id")?,
            r.try_get::<String, _>("outcome")?,
            r.try_get("revision")?,
        )
    } else {
        let result = if let Some(save) = save {
            save_card(&mut tx, &owner, save).await?
        } else {
            change_card(
                &mut tx,
                &owner,
                id.ok_or_else(internal)?,
                command.ok_or_else(internal)?,
            )
            .await?
        };
        sqlx::query("INSERT INTO card_receipts(owner_id,request_id,payload_hash,card_id,outcome,revision) VALUES($1,$2,$3,$4,$5,$6)").bind(&owner).bind(request_id).bind(hash).bind(result.0).bind(&result.1).bind(result.2).execute(&mut *tx).await?;
        result
    };
    let card = get(&mut tx, &owner, card_id).await?;
    tx.commit().await?;
    Ok(json_response(
        json!({"card":card,"cardId":card_id,"outcome":outcome,"revision":revision}),
    ))
}
// JSON property order is part of the Node implementation's durable HMAC input.
// Explicit serialization preserves receipts created before the Rust cutover.
fn content_json(c: &Content) -> String {
    serde_json::to_string(c).expect("content serialization")
}
fn s(v: impl Serialize) -> String {
    serde_json::to_string(&v).expect("JSON serialization")
}
fn legacy_save(v: &Save) -> String {
    format!(
        "{{\"action\":\"save\",\"requestId\":{},\"content\":{},\"source\":{},\"model\":{},\"promptVersion\":{}}}",
        s(v.request_id),
        content_json(&v.content),
        s(&v.source),
        s(&v.model),
        s(&v.prompt_version)
    )
}
fn legacy_command(id: Uuid, c: &Command) -> String {
    let (req, revision) = c.base();
    let (action, extra) = match c {
        Command::Edit { content, .. } => {
            ("edit", format!(",\"content\":{}", content_json(content)))
        }
        Command::Undo {
            save_request_id, ..
        } => ("undo", format!(",\"saveRequestId\":{}", s(save_request_id))),
        Command::Archive { .. } => ("archive", String::new()),
        Command::Restore { .. } => ("restore", String::new()),
        Command::Delete { .. } => ("delete", String::new()),
        Command::Reset { .. } => ("reset", String::new()),
    };
    format!(
        "{{\"id\":{},\"requestId\":{},\"revision\":{},\"action\":{}{extra}}}",
        s(id),
        s(req),
        revision,
        s(action)
    )
}
async fn save_card(c: &mut PgConnection, owner: &str, save: Save) -> Result<(Uuid, String, i32)> {
    let fp = fingerprint(&save.content);
    if let Some(id) = duplicate(c, owner, &fp, None).await? {
        let card = get(c, owner, id).await?.ok_or_else(internal)?;
        return Ok((id, "duplicate".into(), card.revision));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO cards(id,owner_id,fingerprint,original_source,model,prompt_version) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(owner).bind(fp).bind(save.source).bind(save.model).bind(save.prompt_version).execute(&mut *c).await?;
    write_version(c, id, 1, &save.content, "translation").await?;
    Ok((id, "created".into(), 1))
}
async fn change_card(
    c: &mut PgConnection,
    owner: &str,
    id: Uuid,
    command: Command,
) -> Result<(Uuid, String, i32)> {
    let card = get(c, owner, id).await?.ok_or_else(not_found)?;
    if card.revision != command.base().1 {
        return Err(ApiError::new(
            409,
            "stale_card",
            "This card changed in another tab or device. Reload it before making another change.",
        ));
    }
    let revision = card.revision;
    match command {
        Command::Undo {
            save_request_id, ..
        } => {
            let r = sqlx::query(
                "SELECT card_id,outcome FROM card_receipts WHERE owner_id=$1 AND request_id=$2",
            )
            .bind(owner)
            .bind(save_request_id)
            .fetch_optional(&mut *c)
            .await?;
            if !r.is_some_and(|r| {
                r.get::<Uuid, _>("card_id") == id && r.get::<String, _>("outcome") == "created"
            }) || revision != 1
            {
                return Err(ApiError::new(
                    409,
                    "cannot_undo",
                    "Undo is only available for your new, unchanged save. Manage this card in My list instead.",
                ));
            }
            sqlx::query("DELETE FROM cards WHERE owner_id=$1 AND id=$2")
                .bind(owner)
                .bind(id)
                .execute(c)
                .await?;
            Ok((id, "undone".into(), revision))
        }
        Command::Delete { .. } => {
            sqlx::query("DELETE FROM cards WHERE owner_id=$1 AND id=$2")
                .bind(owner)
                .bind(id)
                .execute(c)
                .await?;
            Ok((id, "deleted".into(), revision))
        }
        Command::Reset { .. } => {
            let now = Utc::now();
            sqlx::query("INSERT INTO review_schedules(card_id,direction,due_at,state) SELECT $1,d.direction,$2,$3::jsonb FROM (VALUES ('ru-en'),('en-ru')) d(direction) ON CONFLICT(card_id,direction) DO UPDATE SET due_at=EXCLUDED.due_at,state=EXCLUDED.state,revision=review_schedules.revision+1").bind(id).bind(now).bind(scheduler::empty(now)).execute(&mut *c).await?;
            sqlx::query(
                "UPDATE cards SET revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
            )
            .bind(owner)
            .bind(id)
            .execute(c)
            .await?;
            Ok((id, "reset".into(), revision + 1))
        }
        Command::Edit { content, .. } => {
            if content == card.content {
                return Ok((id, "unchanged".into(), revision));
            }
            let fp = fingerprint(&content);
            if card.status == "active" && duplicate(c, owner, &fp, Some(id)).await?.is_some() {
                return Err(ApiError::new(
                    409,
                    "duplicate_card",
                    "An active card already has this meaning and context. No changes were saved.",
                ));
            }
            write_version(c, id, card.version + 1, &content, "owner_edit").await?;
            sqlx::query("UPDATE cards SET current_version=current_version+1,revision=revision+1,fingerprint=$3,updated_at=now() WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).bind(fp).execute(c).await?;
            Ok((id, "updated".into(), revision + 1))
        }
        command => {
            let (status, outcome) = if matches!(command, Command::Archive { .. }) {
                ("archived", "archived")
            } else {
                ("active", "restored")
            };
            if card.status == status {
                return Ok((id, "unchanged".into(), revision));
            }
            if status == "active"
                && duplicate(c, owner, &fingerprint(&card.content), Some(id))
                    .await?
                    .is_some()
            {
                return Err(ApiError::new(
                    409,
                    "duplicate_card",
                    "An active card already has this meaning and context. The archived card was not restored.",
                ));
            }
            sqlx::query("UPDATE cards SET status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).bind(status).execute(c).await?;
            Ok((id, outcome.into(), revision + 1))
        }
    }
}
fn not_found() -> ApiError {
    ApiError::new(404, "not_found", "This card is no longer available.")
}
