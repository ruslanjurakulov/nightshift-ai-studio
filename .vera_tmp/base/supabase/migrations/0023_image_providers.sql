-- 0023: more image generators for "Run now" on the queue.
--
-- The pipeline now accepts these image providers (modules/image_providers.py,
-- daily_video.yml's image_provider choice list): gpt-image (OpenAI),
-- nano-banana (Google Gemini image), flux (Black Forest Labs), ideogram and
-- fal (fal.ai), next to pexels and leonardo. render_job_params_valid (0017)
-- whitelists the same list, so without this a queued "Run now" naming one of
-- the new providers would be refused by the insert policy.
--
-- Only that one list changes: the function below is 0017's, verbatim
-- otherwise. Safe to run again.

create or replace function public.render_job_params_valid(p jsonb, p_kind text)
  returns boolean
  language plpgsql immutable as $$
declare
  k text;
  allowed text[] := array['topic','niche','privacy','duration','language','visual_style',
                          'video_provider','image_provider','resume','repair_scenes'];
  has_repair boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any(allowed)) then
      return false;
    end if;
  end loop;

  foreach k in array array['topic','niche','language','visual_style','repair_scenes'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'string' then
      return false;
    end if;
  end loop;
  if length(coalesce(p ->> 'topic', '')) > 300
     or length(coalesce(p ->> 'niche', '')) > 120
     or length(coalesce(p ->> 'language', '')) > 40
     or length(coalesce(p ->> 'visual_style', '')) > 300
     or length(coalesce(p ->> 'repair_scenes', '')) > 120 then
    return false;
  end if;

  if p ? 'duration' then
    if jsonb_typeof(p -> 'duration') <> 'number' then
      return false;
    end if;
    if (p ->> 'duration')::numeric <> trunc((p ->> 'duration')::numeric)
       or (p ->> 'duration')::numeric not between 30 and 3600 then
      return false;
    end if;
  end if;

  if p ? 'privacy' and (jsonb_typeof(p -> 'privacy') <> 'string'
                        or p ->> 'privacy' not in ('private', 'unlisted', 'public')) then
    return false;
  end if;
  if p ? 'video_provider' and (jsonb_typeof(p -> 'video_provider') <> 'string'
      or p ->> 'video_provider' not in ('minimax','higgsfield','kling','veo','seedance','wan')) then
    return false;
  end if;
  if p ? 'image_provider' and (jsonb_typeof(p -> 'image_provider') <> 'string'
      or p ->> 'image_provider' not in ('pexels','leonardo','gpt-image','nano-banana',
                                         'flux','ideogram','fal')) then
    return false;
  end if;
  if p ? 'resume' and jsonb_typeof(p -> 'resume') <> 'boolean' then
    return false;
  end if;

  has_repair := length(btrim(coalesce(p ->> 'repair_scenes', ''))) > 0;
  if p_kind = 'repair' then
    return has_repair and coalesce((p ->> 'resume')::boolean, false) = false;
  end if;
  return not has_repair;
end
$$;
