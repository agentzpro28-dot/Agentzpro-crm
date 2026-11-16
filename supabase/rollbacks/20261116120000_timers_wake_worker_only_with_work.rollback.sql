-- Undo 20261116120000_timers_wake_worker_only_with_work.sql.
-- Puts both jobs back to calling their worker route every minute with the exact commands from
-- 20261021120000_worker_cron_jobs.sql, then drops the four timer functions. Nothing else changes.

select cron.schedule('crm-label-classification', '* * * * *',
  $$ select private.invoke_scheduled_worker('/api/queues/ai/label-classification') $$);
select cron.schedule('crm-task-reminders', '* * * * *',
  $$ select private.invoke_scheduled_worker('/api/queues/tasks/reminders') $$);

drop function if exists private.run_label_classification_timer(timestamptz);
drop function if exists private.run_task_reminder_timer(timestamptz);
drop function if exists private.label_classification_worker_has_work();
drop function if exists private.task_reminder_worker_has_work();
