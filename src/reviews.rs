use super::*;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;
const VALIDATION: &str = "Check your answer and try again.";
const RETIRED: &str = "NOT EXISTS (SELECT 1 FROM review_events e WHERE e.owner_id=$1 AND e.card_id=c.id AND (e.reviewed_at AT TIME ZONE $4)::date=$3::date)";
const SCHEDULER_VERSION: &str = "rust-fsrs-6/ts-fsrs-5.2.0-compatible/webcards-v2";
fn error(code: &'static str, message: &str) -> ApiError {
    ApiError::new(409, code, message)
}
async fn ensure(c: &mut PgConnection, owner: &str, now: DateTime<Utc>) -> Result<()> {
    sqlx::query("INSERT INTO review_schedules(card_id,direction,due_at,state) SELECT c.id,d.direction,c.created_at,$2::jsonb FROM cards c CROSS JOIN (VALUES ('ru-en'),('en-ru')) d(direction) WHERE c.owner_id=$1 ON CONFLICT DO NOTHING").bind(owner).bind(scheduler::empty(now)).execute(c).await?;
    Ok(())
}
async fn prune(c: &mut PgConnection, owner: &str, now: DateTime<Utc>) -> Result<()> {
    sqlx::query("UPDATE review_items i SET status='skipped' FROM review_sessions s,cards c WHERE i.session_id=s.id AND s.owner_id=$1 AND i.card_id=c.id AND i.status='pending' AND (c.status<>'active' OR c.current_version<>i.card_version OR NOT EXISTS (SELECT 1 FROM review_schedules r WHERE r.card_id=i.card_id AND r.direction=i.direction AND r.revision=i.schedule_revision) OR EXISTS (SELECT 1 FROM review_events e JOIN owner_preferences p ON p.owner_id=e.owner_id WHERE e.card_id=i.card_id AND e.owner_id=$1 AND (e.reviewed_at AT TIME ZONE p.timezone)::date=($2::timestamptz AT TIME ZONE p.timezone)::date))").bind(owner).bind(now).execute(&mut *c).await?;
    sqlx::query("UPDATE review_sessions s SET active=false WHERE owner_id=$1 AND active AND NOT EXISTS (SELECT 1 FROM review_items i WHERE i.session_id=s.id AND i.status='pending')").bind(owner).execute(c).await?;
    Ok(())
}
async fn timezone(c: &mut PgConnection, owner: &str) -> Result<String> {
    sqlx::query_scalar("SELECT timezone FROM owner_preferences WHERE owner_id=$1")
        .bind(owner)
        .fetch_optional(c)
        .await?
        .ok_or_else(|| ApiError::new(404, "owner", "Owner preferences are unavailable."))
}
fn day(now: DateTime<Utc>, timezone: &str) -> Result<String> {
    let tz: chrono_tz::Tz = timezone.parse().map_err(|_| internal())?;
    Ok(now.with_timezone(&tz).format("%Y-%m-%d").to_string())
}
#[derive(Clone)]
struct Item {
    id: Uuid,
    session: Uuid,
    card: Uuid,
    version: i32,
    direction: String,
    revision: i32,
    available: DateTime<Utc>,
    answer: Option<String>,
    grade: Option<Value>,
    revealed: bool,
    status: String,
    result: Option<Value>,
    content: Value,
}
async fn item(c: &mut PgConnection, owner: &str, id: Uuid) -> Result<Item> {
    let r=sqlx::query("SELECT i.*,json_build_object('russian',v.russian,'english',v.english,'sense',v.sense,'context',v.context,'note',v.note) AS content FROM review_items i JOIN review_sessions s ON s.id=i.session_id JOIN card_versions v ON v.card_id=i.card_id AND v.version=i.card_version WHERE s.owner_id=$1 AND i.id=$2").bind(owner).bind(id).fetch_optional(c).await?.ok_or_else(||ApiError::new(404,"not_found","This review is no longer available."))?;
    Ok(Item {
        id: r.try_get("id")?,
        session: r.try_get("session_id")?,
        card: r.try_get("card_id")?,
        version: r.try_get("card_version")?,
        direction: r.try_get("direction")?,
        revision: r.try_get("schedule_revision")?,
        available: r.try_get("available_at")?,
        answer: r.try_get("answer")?,
        grade: r.try_get("grade")?,
        revealed: r.try_get("revealed")?,
        status: r.try_get("status")?,
        result: r.try_get("result")?,
        content: r.try_get("content")?,
    })
}
fn sides(i: &Item) -> (&str, &str) {
    if i.direction == "ru-en" {
        (
            i.content["russian"].as_str().unwrap_or(""),
            i.content["english"].as_str().unwrap_or(""),
        )
    } else {
        (
            i.content["english"].as_str().unwrap_or(""),
            i.content["russian"].as_str().unwrap_or(""),
        )
    }
}
async fn valid(c: &mut PgConnection, owner: &str, id: Uuid, now: DateTime<Utc>) -> Result<Item> {
    prune(c, owner, now).await?;
    let i = item(c, owner, id).await?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cards c JOIN review_schedules r ON r.card_id=c.id JOIN review_sessions s ON s.id=$6 WHERE c.id=$1 AND c.owner_id=$2 AND c.status='active' AND c.current_version=$3 AND r.direction=$4 AND r.revision=$5 AND s.active)").bind(i.card).bind(owner).bind(i.version).bind(&i.direction).bind(i.revision).bind(i.session).fetch_one(&mut *c).await?;
    if i.status != "pending" || !exists {
        return Err(error(
            "stale_review",
            "This review changed. Reload Today; no additional schedule change was made.",
        ));
    }
    if i.available > now {
        return Err(error(
            "not_due",
            "This card is not due yet. You can pause and return later.",
        ));
    }
    let head:Option<Uuid>=sqlx::query_scalar("SELECT id FROM review_items WHERE session_id=$1 AND status='pending' ORDER BY position LIMIT 1").bind(i.session).fetch_optional(c).await?;
    if head != Some(id) {
        return Err(error("queue_order", "Continue the current question first."));
    }
    Ok(i)
}
async fn today(app: &App, owner: &str, now: DateTime<Utc>) -> Result<Value> {
    let mut c = app.transaction(owner).await?;
    ensure(&mut c, owner, now).await?;
    prune(&mut c, owner, now).await?;
    let tz = timezone(&mut c, owner).await?;
    let day = day(now, &tz)?;
    let progress=sqlx::query("SELECT count(DISTINCT card_id)::int AS completed,count(*)::int AS attempts FROM review_events WHERE owner_id=$1 AND (reviewed_at AT TIME ZONE $2)::date=$3::date").bind(owner).bind(&tz).bind(&day).fetch_one(&mut *c).await?;
    let due=sqlx::query(&format!("SELECT count(DISTINCT c.id)::int AS cards,count(*)::int AS directions FROM review_schedules r JOIN cards c ON c.id=r.card_id WHERE c.owner_id=$1 AND c.status='active' AND r.due_at<=$2 AND {RETIRED}")).bind(owner).bind(now).bind(&day).bind(&tz).fetch_one(&mut *c).await?;
    let active: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM review_sessions WHERE owner_id=$1 AND active")
            .bind(owner)
            .fetch_optional(&mut *c)
            .await?;
    let mut session = Value::Null;
    if let Some(sid) = active {
        let head=sqlx::query("SELECT id,count(*) OVER()::int AS remaining FROM review_items WHERE session_id=$1 AND status='pending' ORDER BY position LIMIT 1").bind(sid).fetch_optional(&mut *c).await?;
        if let Some(head) = head {
            let i = item(&mut c, owner, head.try_get("id")?).await?;
            let (prompt, reference) = sides(&i);
            session = json!({"id":sid,"remaining":head.try_get::<i32,_>("remaining")?,"item":{"id":i.id,"cardId":i.card,"direction":i.direction,"prompt":prompt,"sense":i.content["sense"],"context":i.content["context"],"answer":i.answer,"reference":if i.grade.is_some()||i.revealed{Some(reference)}else{None},"grade":i.grade,"availableAt":iso(i.available)}})
        }
    }
    let result = json!({"timezone":tz,"day":day,"completed":progress.try_get::<i32,_>("completed")?,"attempts":progress.try_get::<i32,_>("attempts")?,"dueCards":due.try_get::<i32,_>("cards")?,"dueDirections":due.try_get::<i32,_>("directions")?,"session":session});
    c.commit().await?;
    Ok(result)
}
async fn start(app: &App, owner: &str, now: DateTime<Utc>) -> Result<()> {
    let mut c = app.transaction(owner).await?;
    ensure(&mut c, owner, now).await?;
    prune(&mut c, owner, now).await?;
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM review_sessions WHERE owner_id=$1 AND active)",
    )
    .bind(owner)
    .fetch_one(&mut *c)
    .await?;
    if active {
        c.commit().await?;
        return Ok(());
    }
    let tz = timezone(&mut c, owner).await?;
    let day = day(now, &tz)?;
    let missed = "(SELECT e.rating='again' FROM review_events e WHERE e.card_id=c.id AND e.direction=r.direction ORDER BY e.reviewed_at DESC,e.attempt_id DESC LIMIT 1)";
    let sql = format!(
        "WITH ranked AS (SELECT c.id,c.current_version,r.direction,r.revision,r.due_at,CASE WHEN {missed} OR (r.state->>'state')::int IN (1,3) THEN 0 WHEN EXISTS(SELECT 1 FROM review_introductions x WHERE x.card_id=c.id) THEN 1 ELSE 2 END AS priority,row_number() OVER(PARTITION BY c.id ORDER BY CASE WHEN {missed} OR (r.state->>'state')::int IN (1,3) THEN 0 ELSE 1 END,r.due_at,CASE WHEN r.direction=CASE WHEN mod(abs(hashtextextended(c.id::text || $3,0)::numeric),2)=0 THEN 'ru-en' ELSE 'en-ru' END THEN 0 ELSE 1 END) AS rank FROM cards c JOIN review_schedules r ON r.card_id=c.id WHERE c.owner_id=$1 AND c.status='active' AND r.due_at<=$2 AND {RETIRED}) SELECT * FROM ranked WHERE rank=1 ORDER BY priority,due_at,id"
    );
    let rows = sqlx::query(&sql)
        .bind(owner)
        .bind(now)
        .bind(&day)
        .bind(&tz)
        .fetch_all(&mut *c)
        .await?;
    if rows.is_empty() {
        c.commit().await?;
        return Ok(());
    }
    let sid = Uuid::new_v4();
    sqlx::query("INSERT INTO review_sessions(id,owner_id,created_at) VALUES($1,$2,$3)")
        .bind(sid)
        .bind(owner)
        .bind(now)
        .execute(&mut *c)
        .await?;
    for (position, r) in rows.into_iter().enumerate() {
        let id: Uuid = r.try_get("id")?;
        sqlx::query("INSERT INTO review_items(id,session_id,card_id,card_version,direction,schedule_revision,position,available_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(Uuid::new_v4()).bind(sid).bind(id).bind(r.try_get::<i32,_>("current_version")?).bind(r.try_get::<String,_>("direction")?).bind(r.try_get::<i32,_>("revision")?).bind(position as i32).bind(now).execute(&mut *c).await?;
        sqlx::query("INSERT INTO review_introductions(card_id,introduced_at) VALUES($1,$2) ON CONFLICT DO NOTHING").bind(id).bind(now).execute(&mut *c).await?;
    }
    c.commit().await?;
    Ok(())
}
async fn end(app: &App, owner: &str, sid: Uuid) -> Result<()> {
    let mut c = app.transaction(owner).await?;
    sqlx::query("UPDATE review_items SET status='skipped' WHERE session_id IN (SELECT id FROM review_sessions WHERE id=$1 AND owner_id=$2) AND status='pending'").bind(sid).bind(owner).execute(&mut *c).await?;
    sqlx::query("UPDATE review_sessions SET active=false WHERE id=$1 AND owner_id=$2")
        .bind(sid)
        .bind(owner)
        .execute(&mut *c)
        .await?;
    c.commit().await?;
    Ok(())
}
async fn reveal(app: &App, owner: &str, id: Uuid, now: DateTime<Utc>) -> Result<()> {
    let mut c = app.transaction(owner).await?;
    let i = valid(&mut c, owner, id, now).await?;
    let grade = json!({"verdict":"incorrect","reason":"Answer revealed without verified recall.","correction":null,"source":"reveal"});
    sqlx::query(
        "UPDATE review_items SET revealed=true,grade=COALESCE(grade,$2::jsonb) WHERE id=$1",
    )
    .bind(i.id)
    .bind(grade)
    .execute(&mut *c)
    .await?;
    c.commit().await?;
    Ok(())
}
async fn check(
    app: &Arc<App>,
    owner: &str,
    id: Uuid,
    answer: &str,
    now: DateTime<Utc>,
) -> Result<()> {
    let key = format!("{owner}:{id}");
    let mut receiver = {
        let mut cache = app.grading.lock().await;
        if let Some(entry) = cache.get(&key) {
            if entry.answer != answer {
                return Err(error("answer_conflict", "Retry the same submitted answer."));
            }
            entry.result.clone()
        } else {
            if cache.len() >= 2 {
                return Err(ApiError::new(
                    429,
                    "busy",
                    "Two answers are being checked. Please wait; your schedule has not changed.",
                ));
            }
            let (sender, receiver) = tokio::sync::watch::channel(None);
            cache.insert(
                key.clone(),
                model::GradeEntry {
                    answer: answer.into(),
                    result: receiver.clone(),
                },
            );
            let app = app.clone();
            let owner = owner.to_owned();
            let answer = answer.to_owned();
            tokio::spawn(async move {
                let result = check_inner(&app, &owner, id, &answer, now).await;
                sender.send_replace(Some(result));
                app.grading.lock().await.remove(&key);
            });
            receiver
        }
    };
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result;
        }
        receiver.changed().await.map_err(|_| internal())?;
    }
}
async fn check_inner(
    app: &App,
    owner: &str,
    id: Uuid,
    answer: &str,
    now: DateTime<Utc>,
) -> Result<()> {
    let mut c = app.transaction(owner).await?;
    let i = valid(&mut c, owner, id, now).await?;
    if i.answer.as_ref().is_some_and(|a| a != answer) {
        return Err(error(
            "answer_conflict",
            "This answer was already submitted. Retry the same answer or use self-assessment.",
        ));
    }
    if i.grade.is_some() {
        c.commit().await?;
        return Ok(());
    }
    if i.revealed {
        return Err(error(
            "revealed",
            "The reference was revealed. Use self-assessment instead.",
        ));
    }
    sqlx::query("UPDATE review_items SET answer=$2 WHERE id=$1")
        .bind(id)
        .bind(answer)
        .execute(&mut *c)
        .await?;
    let reference = sides(&i).1;
    let exact = cards::normalize(answer) == cards::normalize(reference);
    if exact {
        let grade = json!({"verdict":"correct","reason":"Matches the saved answer (NFC and whitespace only).","correction":null,"source":"exact"});
        sqlx::query("UPDATE review_items SET grade=$2 WHERE id=$1")
            .bind(id)
            .bind(grade)
            .execute(&mut *c)
            .await?;
        c.commit().await?;
        return Ok(());
    }
    c.commit().await?;
    let reserved=sqlx::query("INSERT INTO grading_usage(owner_id,day,requests) VALUES($1,(now() AT TIME ZONE 'UTC')::date,2) ON CONFLICT(owner_id,day) DO UPDATE SET requests=grading_usage.requests+2 WHERE grading_usage.requests+2<=$2 RETURNING requests").bind(owner).bind(app.config.gradings_per_day).fetch_optional(&app.db).await?;
    if reserved.is_none() {
        return Err(ApiError::new(
            429,
            "daily_limit",
            "Today's grading budget is used. Reveal and self-assess; no schedule changed.",
        ));
    }
    let grade = model::grade_answer(app, &i.content, &i.direction, answer).await?;
    let mut c = app.transaction(owner).await?;
    let i = valid(&mut c, owner, id, Utc::now()).await?;
    if i.answer.as_deref() != Some(answer) {
        return Err(error("answer_conflict", "The submitted answer changed."));
    }
    if i.grade.is_none() && !i.revealed {
        sqlx::query("UPDATE review_items SET grade=$2 WHERE id=$1")
            .bind(id)
            .bind(grade)
            .execute(&mut *c)
            .await?;
    }
    c.commit().await?;
    Ok(())
}
async fn finalize(
    app: &App,
    owner: &str,
    id: Uuid,
    decision: &str,
    now: DateTime<Utc>,
) -> Result<()> {
    let mut c = app.transaction(owner).await?;
    let previous = item(&mut c, owner, id).await?;
    if let Some(result) = previous.result {
        if result["decision"] != decision {
            return Err(error(
                "decision_conflict",
                "This review was already finalized with another decision.",
            ));
        }
        c.commit().await?;
        return Ok(());
    }
    let i = valid(&mut c, owner, id, now).await?;
    if decision == "skip" {
        sqlx::query("UPDATE review_items SET status='skipped',result=$2 WHERE id=$1")
            .bind(id)
            .bind(json!({"decision":decision}))
            .execute(&mut *c)
            .await?;
        prune(&mut c, owner, now).await?;
        c.commit().await?;
        return Ok(());
    }
    let grade = i.grade.ok_or_else(|| {
        error(
            "unchecked",
            "Check or reveal the answer before rating recall.",
        )
    })?;
    let rating = if decision == "accept" {
        match grade["verdict"].as_str() {
            Some("correct") => "good",
            Some("incorrect") => "again",
            _ => {
                return Err(error(
                    "self_assessment",
                    "This judgment needs your self-assessment. Scheduling has not changed.",
                ));
            }
        }
    } else {
        decision
    };
    let before: Value =
        sqlx::query_scalar("SELECT state FROM review_schedules WHERE card_id=$1 AND direction=$2")
            .bind(i.card)
            .bind(&i.direction)
            .fetch_one(&mut *c)
            .await?;
    let mut after = scheduler::next(&before, rating, now);
    let tz = timezone(&mut c, owner).await?;
    let next_day: DateTime<Utc> = sqlx::query_scalar(
        "SELECT ((($1::timestamptz AT TIME ZONE $2)::date + 1)::timestamp AT TIME ZONE $2)",
    )
    .bind(now)
    .bind(tz)
    .fetch_one(&mut *c)
    .await?;
    let due = DateTime::parse_from_rfc3339(after["due"].as_str().ok_or_else(internal)?)
        .map_err(|_| internal())?
        .with_timezone(&Utc);
    let due = if rating == "again" || due < next_day {
        next_day
    } else {
        due
    };
    after["due"] = json!(iso(due));
    let params: Value = serde_json::from_str(include_str!("../fixtures/scheduler-parameters.json"))
        .map_err(|_| internal())?;
    sqlx::query("INSERT INTO review_events(attempt_id,owner_id,card_id,card_version,direction,answer,grade,rating,source,reviewed_at,before_state,after_state,scheduler_version,scheduler_parameters) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)").bind(id).bind(owner).bind(i.card).bind(i.version).bind(&i.direction).bind(i.answer).bind(grade).bind(rating).bind(if decision=="accept"{"automatic"}else{"self"}).bind(now).bind(before).bind(&after).bind(SCHEDULER_VERSION).bind(params).execute(&mut *c).await?;
    let updated=sqlx::query("UPDATE review_schedules SET state=$4,due_at=$5,revision=revision+1 WHERE card_id=$1 AND direction=$2 AND revision=$3 RETURNING revision").bind(i.card).bind(i.direction).bind(i.revision).bind(after).bind(due).fetch_optional(&mut *c).await?;
    if updated.is_none() {
        return Err(error(
            "schedule_conflict",
            "Another tab already reviewed this direction.",
        ));
    }
    sqlx::query("UPDATE review_items SET status='finalized',result=$2 WHERE id=$1")
        .bind(id)
        .bind(json!({"decision":decision,"dueAt":iso(due)}))
        .execute(&mut *c)
        .await?;
    prune(&mut c, owner, now).await?;
    c.commit().await?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Command {
    Start,
    End {
        #[serde(rename = "sessionId")]
        session_id: Uuid,
    },
    Check {
        #[serde(rename = "itemId")]
        item_id: Uuid,
        answer: String,
    },
    Reveal {
        #[serde(rename = "itemId")]
        item_id: Uuid,
    },
    Finalize {
        #[serde(rename = "itemId")]
        item_id: Uuid,
        decision: String,
    },
}
pub(crate) async fn handler(app: Arc<App>, request: Request) -> Result<Response> {
    method_allowed(request.method(), &[Method::GET, Method::POST])?;
    if request.method() == Method::POST {
        app.check_origin(request.headers())?
    }
    let owner = app
        .owner(request.headers())
        .await?
        .ok_or_else(|| {
            ApiError::new(
                401,
                "unauthorized",
                "Please sign in again to review your vocabulary.",
            )
        })?
        .user_id;
    let now = Utc::now();
    if request.method() == Method::GET {
        return today(&app, &owner, now).await.map(json_response);
    }
    let v = read_json(request, 16384).await?;
    let command: Command = serde_json::from_value(v).map_err(|_| validation(VALIDATION))?;
    match command {
        Command::Start => start(&app, &owner, now).await?,
        Command::End { session_id } => end(&app, &owner, session_id).await?,
        Command::Check { item_id, answer } => {
            let answer = cards::clean(&answer, 1000, true).map_err(|_| validation(VALIDATION))?;
            check(&app, &owner, item_id, &answer, now).await?
        }
        Command::Reveal { item_id } => reveal(&app, &owner, item_id, now).await?,
        Command::Finalize { item_id, decision } => {
            if !matches!(decision.as_str(), "accept" | "good" | "again" | "skip") {
                return Err(validation(VALIDATION));
            }
            finalize(&app, &owner, item_id, &decision, now).await?
        }
    }
    today(&app, &owner, Utc::now()).await.map(json_response)
}
