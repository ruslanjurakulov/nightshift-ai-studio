select 'identity current_user=' || current_user;
select 'identity session_user=' || session_user;
select 'database=' || current_database();

select 'table schema=' || n.nspname || ' name=' || c.relname ||
       ' owner=' || r.rolname || ' relkind=' || c.relkind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_roles r on r.oid = c.relowner
where n.nspname = 'storage' and c.relname in ('objects', 'buckets')
order by c.relname;

select 'membership member=' || member.rolname || ' granted=' || parent.rolname ||
       ' inherit=' || member.rolinherit
from pg_auth_members am
join pg_roles member on member.oid = am.member
join pg_roles parent on parent.oid = am.roleid
where member.rolname in (current_user, session_user)
   or parent.rolname like '%storage%'
order by member.rolname, parent.rolname;

select 'role_usage current_user=' || pg_has_role(current_user, 'USAGE');
select 'role_usage session_user=' || pg_has_role(session_user, 'USAGE');
select 'is_owner objects=' || (pg_get_userbyid(c.relowner) = current_user)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'storage' and c.relname = 'objects';
select 'is_owner buckets=' || (pg_get_userbyid(c.relowner) = current_user)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'storage' and c.relname = 'buckets';
