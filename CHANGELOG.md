# Changelog

## 0.24.1 — 2026-07-07

Round 2 do feedback dos agentes vivos (2026-07-07, 0.24.0) — três correções, uma delas grave
porque mente na ferramenta anti-redo. Skill spine → **rev 11**.

- **cli#76.1: `catchup --digest` mentia `PENDING` numa mensagem JÁ PROCESSADA (MEDIUM-HIGH — os DOIS
  agentes acharam independentemente).** O estado da linha vinha SÓ de `handler_summary`/`acked_by_label`
  (ausentes quando o ack foi sem nota), ignorando `processed_at`: uma msg com `processed_at` mas sem nota
  imprimia `PENDING` → um sucessor re-fazia trabalho já feito (o incidente que a feature existe pra matar).
  Agora são **TRÊS estados**: `handled by X: <nota>` (nota presente) · `✓ acked (no note)` (`processed_at`
  ou label presente, sem nota — feito em silêncio, NÃO é pra refazer) · `PENDING` (de fato não processado).
- **cli#76.2: o auto-tip do cursor não aparecia.** O gate antigo (só quando existia um cursor anterior E a
  thread tinha avançado além dele) fazia um canal fresco — ou um canal quieto lido algumas vezes — não
  imprimir tip NENHUM (o que os agentes viram: ~5 runs sem `--since`, zero tip). Não era gate por TTY (já
  era stderr), era a condição. Agora **todo run sem `--since` que viu mensagens imprime o cursor no stderr**
  (o stdout — JSON ou digest — fica limpo), apontando pro id mais alto atual (`--since <highest>` = só o que
  chegar depois).
- **cli#76.3: `pidge doctor` avisa quando `~/.claude/skills/pidge/SKILL.md` existe SEM o marcador pidge.**
  Resíduo do cli#69: uma skill pré-marcador no home é (corretamente) NÃO tocada pelo self-heal — mas aí o
  agente segue em doutrina velha sem saber. doctor não pode curar (pode ser autoral), mas agora **DIZ**:
  aponta o arquivo e sugere `cd ~ && npx pidge-cli skill install` (a atual vai pra `.bak`); nunca escreve.

## 0.24.0 — 2026-07-06

Dois achados dos agentes vivos que atacam a mesma dor — "situar-se sem redundância". Skill spine
→ **rev 10**.

- **cli#69: o self-heal da skill agora cobre o path HOME (`~/.claude/skills/pidge`), não só o do projeto.**
  O `ensureSkillFresh` resolvia SÓ o path relativo ao cwd (`.claude/skills/pidge/SKILL.md`), então uma
  skill instalada no HOME — que o Claude Code também carrega, e que instalações antigas usavam — nunca
  era visitada. O Javier operou **3 SEMANAS** com a doutrina v26 (rev 6) porque a home skill dele nunca
  se curou, sem nenhum aviso. Agora o self-heal checa **AMBOS** os paths (projeto + home) numa passada
  e cura cada cópia obsoleta **no lugar** (nunca cross-escreve). **Escolha: curar em silêncio, não só
  avisar.** O conteúdo gerado é agnóstico de agente E de projeto (não embute token — só a versão do
  manifest do servidor + a doutrina fixa), então qualquer projeto regenera a MESMA skill; um usuário
  multi-servidor no máximo vê o número do manifest oscilar (regeneração best-effort, uma vez por
  processo, engolida em falha). Um doctor mudo não bastava — o healing silencioso fecha o buraco sem
  ação humana, que é a promessa do #280. **Cross-audit:** o path HOME só cura arquivo COM o marcador
  pidge — um `~/.claude/skills/pidge/SKILL.md` sem marcador é AUTORAL e fica intocado (o path de projeto
  mantém a semântica de curar até sem marcador, já coberta por teste #38).
- **cli#70: `pidge catchup` ganha `--since <id>` (cursor incremental) + `--digest` (1 linha/msg).**
  Dois agentes convergiram: o catchup era JSON cru da thread inteira — pra responder "o que rolou desde
  minha última sessão" o agente puxava O(thread) e olhava no olho. Agora **`--since <id>`** filtra pros
  ids ESTRITAMENTE maiores (forwarded ao servidor E enforced client-side — O(novos), aceitável ≤200; id
  STRICT como `--up-to`/`--ids`), e **`--digest`** condensa cada msg em **`id · kind · <60 chars> · handled
  by X: <summary>` (ou `PENDING`)** — a visão "o que rolou, quem tratou o quê" antes de oferecer trabalho.
  O catchup lembra o maior id que imprimiu (`state.json`, **keyed por hash(token) — per-CHANNEL, o mesmo
  keying do pin #313**, pra que o cursor do canal A não vaze pro `--since` sugerido do canal B) e, num run
  seguinte sem `--since`, **sugere o cursor**; o cursor só AVANÇA (um `--before`, com highest menor, nunca
  regride). A seção de início de sessão da skill agora recomenda **`pidge catchup --digest --since <last>`**.

## 0.23.1 — 2026-07-06

Feedback de três agentes vivos (Invest/canal 4, Javier/canal 7, Codex/full E2E — 2026-07-06,
0.23.0): a doutrina da skill estava atrás do CLI e dois comandos de onboarding prendiam a sessão.
Skill spine → **rev 9** (self-heal propaga sem ação humana).

- **cli#68/#67: a skill ganha `pidge bridge` + `ack --summary`, o bloco multi-agente e 3 fixes de prosa.**
  A skill instalada (rev 8) tinha **ZERO** ocorrências de `bridge` (o agente cujo ponto de entrada é a
  skill nunca descobria que o supervisor 24/7 existe) e citava `ack --summary` só pelo efeito, nunca
  como comando. Agora: uma **seção `## The 24/7 supervisor: pidge bridge`** (--exec, lockfile de 1
  consumidor, `bridge install`, o marker `pidge-summary:`) depois do bloco always-on; uma **linha
  `Ack with attribution`** ensinando `ack --up-to <id> --summary "<o que você fez>"` como hábito; e o
  **bloco multi-agente** (`PIDGE_AGENT=<id>` em TODA sessão, config em `~/.config/pidge/agents/<id>/env`,
  nunca `setup --force`) logo no topo — num host com N agentes, seguir os exemplos sem `PIDGE_AGENT`
  fala pelo canal errado (achado do Codex, #67). Prosa: (1) "be listening… or you lose it" → a fila é
  durável (at-least-once, nada se perde; o que se perde é TEMPO, não a mensagem), (2) "English only" →
  escreva no idioma do humano, espelhe o canal, (3) o exemplo de agente turn-based agora abrange
  "Claude Code, Codex, Gemini CLI", não um só.
- **cli#71: `pidge doctor` SEMPRE reporta o estado do backlog de claim anterior — não só no `true`.**
  O `doctor` só falava quando `stale_from_prior_claim` era true; no caso saudável (o comum) ficava
  **silencioso**, e "não vi o warning" ≠ "não há backlog órfão" — um doctor mudo não confirma saúde
  (Javier D2 + Invest D3, mesmo achado independente). Agora, quando o campo vem explicitamente `false`
  (server v63+), o doctor imprime **`prior-claim backlog: none ✓`**; o warning do #61 segue cobrindo o
  `true`. Um server antigo que omite o campo continua silencioso (não dá pra confirmar o que não vem).
- **cli#71: `pidge hello` ganha `--timeout` (default 120s) com exit 3 narrado — não prende mais a sessão.**
  O `hello` obedecia a sugestão do template onboarding (~3600s), então uma sessão fresca ficava
  **presa indefinidamente** esperando a confirmação humana (o Codex teve que MATAR o processo; a
  confirmação chegou depois via `listen --all`, corretamente). Agora `--timeout` default **120s**
  (explícito sempre vence) e um timeout **exita 3 narrado** ("sem confirmação ainda — ela fica na sua
  fila; `pidge listen --all` pega quando seu humano tocar"), espelhando o contrato do `ask`/`wait`.

## 0.23.0 — 2026-07-06

Bateria multi-runtime (2026-07-06, 0.22.0 vs server v63) — três achados de atribuição/leitura:

- **cli#63: `pidge ack --summary "<o que você fez>"` — resolvida a colisão de tipo (era no-op silencioso).**
  `--summary` é registrada globalmente como BOOLEAN (pro `inbox --summary` = contagens+latência),
  então o parse global engolia `ack --summary "texto"` como boolean-true e jogava o "texto" num
  positional ignorado — um **no-op silencioso num campo de ATRIBUIÇÃO**, o pior modo de falha. O
  case `ack` agora **re-parseia o próprio argv** com `summary` tipado como string: o valor
  sobrevive, entra no `ackBody` (cap 1000, o servidor #380 grava `handler_summary`) e o `pidge
  catchup` mostra "handled by X: <summary>" pra sessão sucessora. Um `--summary` **sem valor** (ou
  vazio) vira **usage-error alto (exit 1)**, nunca um no-op. `inbox --summary` segue funcionando
  intacto (é a metade boolean).
- **cli#65: `selftest` não sequestra mais mensagens reais (era um blackout de ~60s — achado T2).**
  O listener do selftest lia a fila real com `?all=true&lease=60`: qualquer mensagem real servida
  de passagem ficava **sob lease por 60s, invisível a qualquer `listen`** nesse intervalo (o
  sintoma: `listen` roda a janela inteira e diz "no message", exit 3, e um segundo `listen`
  imediato acha a mesma mensagem na hora). Agora lê com **`?since=<id do nonce − 1>`** (o POST
  `/selftest` devolve o id): o backlog **pré-existente** (ids menores) some por construção. O
  `lease=60` **fica** como defesa em profundidade (cross-audit do PR #66): uma mensagem real que
  chega **durante** a janela tem id > nonce, é servida, e sem o `lease=60` ganharia o lease
  **default de ~10 min** do stamp_delivered (10× pior que o bug original) — o `since=` tira o
  backlog da leitura, o `lease=60` limita o blackout de qualquer coisa ainda servida a ~60s. O
  **exit 3 do `listen`** ganhou a dica: "se você esperava uma mensagem, ela pode estar sob lease
  de outra leitura — `pidge catchup` mostra a fila inteira read-only".
- **cli#64: o `bridge` captura o summary do handler via MARKER LINE (o "o quê" do server #380).**
  O `ackBatch` do bridge mandava só `{ids}` — o caso central do #380 (sessão sucessora vendo QUEM
  tratou O QUÊ) ficava manco no cenário pra que foi feito (bridge 24/7 → sessão interativa). Agora
  o stdout do handler vira `pipe` **com tee pro log** (comportamento preservado) e o bridge varre
  (em **stream, nunca buffer total** — um handler que despeja MB ou fecha stdout cedo não trava nem
  estoura memória) a **ÚLTIMA** linha `pidge-summary: <texto>` (cap 1000). Achou → `ackBatch({ids,
  summary})`; não achou → acka sem summary (**nunca inventa**). Só uma linha que COMEÇA com o
  marcador conta — output incidental jamais vira atribuição. Um handler LLM é instruível no próprio
  prompt: "termine imprimindo `pidge-summary: <1 frase do que você fez>`". Documentado no HELP do
  bridge + README.

## 0.22.0 — 2026-07-06

- **cli#59: `pidge bridge --exec '<handler>'` — o supervisor de 1ª classe, model-agnostic.**
  A produtização do "colo um prompt e o agent fica online": loop supervisionado embutido —
  long-poll `GET /messages?all=true` (o piso robusto do #119; o socket realtime, quando
  disponível, é presença "ouvindo agora" + acorda-cedo, NUNCA o caminho dos dados) → o handler
  roda **UMA vez por lote** com o batch JSON no stdin (`{"messages":[…]}` + `history_hint:true`
  no primeiro lote pós-restart — sinergia com o `catchup` do #58) → exit 0 ⇒ **ack dos ids
  EXATOS do lote** (nunca um watermark `up_to`: no servidor ele flipa TODA unprocessed ≤ id,
  inclusive rows sob lease de um lote anterior que o handler FALHOU — blocker do cross-audit
  do PR #62) · exit ≠0 ⇒ **NÃO acka** (o lease de ~10 min do servidor re-serve; at-least-once
  é o contrato — o handler deve ser idempotente). Uma invocação é limitada por
  `--handler-timeout` (default 30 min: SIGTERM, SIGKILL 5 s depois, conta como lote FALHADO —
  um handler pendurado não trava o canal), com heartbeat no stderr a cada 5 min enquanto roda. Model-agnostic por construção:
  `--exec 'claude -p …' | 'codex exec …' | 'gemini …'` | qualquer script. O bridge é burro de
  propósito: sem fila local, sem ledger próprio — a durabilidade é do servidor (ack/lease).
- **Lock de instância única por canal (#59 §3).** Lockfile por `hash(token)` em
  `~/.config/pidge/bridge-<hash>.lock` (o dir BASE, ignorando `PIDGE_AGENT` de propósito: dois
  agents com a MESMA chave são um canal só e DEVEM colidir), criado com `O_EXCL` + PID dentro.
  Segundo `bridge` no mesmo canal recusa (exit 2, mensagem clara apontando pro `catchup` +
  a instrução de `rm` do lockfile pra quem tem CERTEZA de que não há bridge);
  **lockfile órfão pós-crash é recuperado por RENAME atômico** (cross-audit PR #62: só um
  racer consegue renomear o arquivo stale; o perdedor ganha ENOENT ⇒ recusa exit 2 — fecha o
  interleaving A-e-B-leem-o-mesmo-stale), com re-read paranóico como cinto extra. EPERM no
  PID-check é tratado como suspeito ⇒ vivo (recusar > double-consume). **`listen` também
  recusa** sob um lock VIVO de bridge (o double-consume local morre por construção).
- **Modos de falha narrados, nunca re-loop cego (#59 §4).** 401 → narra + **alerta LOCAL**
  (stderr é o registro; notificação de desktop best-effort — `osascript`/`notify-send`;
  `PIDGE_BRIDGE_ALERT=0` desliga) + backoff LONGO com jitter, re-tenta pra sempre (chave
  rotacionada só um humano conserta — o daemon não morre em silêncio nem flapa no launchd).
  Canal quebrado (a classe do exit 4: N falhas consecutivas sem round-trip saudável) → mesmo
  tratamento. TODO sleep de retry tem jitter (N bridges pós-deploy não estoram em lockstep).
  Handler quebrado escala backoff próprio (um handler morto não queima 1 chamada de LLM por
  mensagem). **SIGTERM/SIGINT limpos:** repassa o sinal ao handler em voo, **não acka o lote em
  voo** (o lease re-serve — a flag `shuttingDown` também fecha a corrida handler-exit→ack),
  solta o lock, exit 0.
- **`pidge bridge install --exec '<handler>'` (#59 §5):** gera o template launchd (Mac,
  `~/Library/LaunchAgents/sh.pidge.bridge[.<agent>].plist`, `KeepAlive.SuccessfulExit=false`)
  ou systemd user (Linux, `~/.config/systemd/user/pidge-bridge[.<agent>].service`,
  `Restart=on-failure`) apontando pro comando, e **declara `listen_mode=external_daemon`** no
  operating contract (advisory, honesto). O template **NUNCA embute a chave** (higiene #57 —
  ela fica no `~/.config/pidge/env`); só env não-secreto (`PIDGE_URL`/`PIDGE_AGENT`/
  `XDG_CONFIG_HOME` + o **PATH corrente** — sem ele um handler homebrew/nvm dá exit 127 sob
  launchd/systemd) viaja. `systemdQuote` escapa `$→$$` e `%→%%` (expansões de unit-file);
  `Wants=network-online.target` junto do `After`. Warn se a chave só existe no env do shell
  (o daemon não herdaria) e se o CLI roda do cache do npx (template quebraria no prune).
- **cli#61 (carona): surfacing do `stale_from_prior_claim`** (server v63 — Bool top-level no
  `GET /messages` de channel-key e no whoami). Aviso de 1 linha, UMA vez por processo, tom
  advisory ("provavelmente de um dono anterior", nunca certeza — falso ± conhecidos,
  pidge#294): no header da sessão do `listen`, no `doctor` (warning, nunca exit 2), no
  `catchup` e no boot do `bridge`.
- Não-objetivos honrados (#59): sem enforcement no servidor (advisory-only), sem fila local.

## 0.21.0 — 2026-07-06

- **cli#58: `pidge catchup` — o verbo READ-ONLY sobre `GET /messages?history=true&all=true`.**
  Imprime a conversa inteira (JSON, mais novo primeiro), respostas de notificação incluídas, e
  **NUNCA consome**: sem ack, sem carimbo delivered, sem lease (o servidor já expõe `history=true`
  desde o #186; o CLI é que não expunha). É como uma sessão interativa se SITUA ao subir num canal
  cujo consumidor real é OUTRO runtime (uma bridge/daemon 24/7) — lê o que já foi tratado sem
  roubar mensagem da fila do consumidor. `--limit N` / `--before ID` paginam. Exit `0` (imprimiu,
  mesmo vazio `{"messages":[]}`) / `2` erro — sem espera, logo sem 3/4. Rows E2E são abertas
  localmente (mesmo caminho do `listen`). `--limit N` é enforçado **client-side** (o servidor
  ignora `limit` no caminho `?history=true`) — fatia os N mais novos após ordenar; `--before ID`
  é honrado pelo servidor. **Item 4 do #58 (server v63 em produção):** uma row PROCESSADA carrega
  `acked_by_label` + `handler_summary`, então o catchup narra `handled by <quem>: <o quê>` no
  stderr por row — o leitor VÊ o que o outro consumidor já fez, não só que a mensagem existe.
  `KNOWN_MANIFEST_VERSION` → **63**.
- **Regra 1-consumidor-por-canal, agora ESCRITA** (era folclore). Quem roda `listen`/`ack`
  **consome** cada mensagem; um segundo runtime que também roda `listen` rouba mensagens do
  consumidor (double-consume — o incidente 2026-07-06). Contrato: situe-se com `catchup`
  (read-only), rode `listen`/`ack` só quando VOCÊ é o único consumidor do canal. Documentada no
  README (seção Contract + tabela de comandos) e na skill.
- **Skill spine rev 8:** a seção multi-runtime é a prosa VERBATIM do comentário da issue #58
  ("Waking up in an interactive session" — título EN, o heurístico do `listen_mode`, o passo
  "Only then speak") + linha no PICKER.
- **`pidge skill install --target claude|agents|gemini`:** o mesmo conteúdo agnóstico, destino
  diferente — `claude` (default) → `.claude/skills/pidge/SKILL.md` · `agents` → `AGENTS.md` ·
  `gemini` → `GEMINI.md` (ambos na raiz). Um arquivo existente que difere vai pro `<dest>.bak`;
  se o `.bak` já existe (re-install), vai pro `<dest>.bak.<timestamp>` — um re-install **nunca**
  destrói o backup original do usuário. A mensagem nomeia o arquivo de destino real (não "SKILL.md").
  **Só o alvo `claude` se auto-cura** (self-heal cobre só `.claude/`); `AGENTS.md`/`GEMINI.md` não
  auto-atualizam — re-rode `pidge skill install --target agents|gemini` pra refrescá-los.

## 0.20.0 — 2026-07-06

- **pidge#367 F1 (E3): mídia SELADA agente→você, atrás do gate de deploy.** Num canal E2E com o
  gate aberto (whoami `e2e_media_ready:true` — todo device deliverable roda um build iOS que ABRE
  blob selado), `--image`/`--file` locais são selados NA MÁQUINA antes do upload
  (`[0x01][nonce][ct][tag]`, AAD `ch<id>:<cid>:image_blob|file_blob` — o cid é mintado ANTES do
  upload), sobem como `blob.bin` genérico, o nome REAL vira envelope `filename` no /notify e o
  send leva `media_enc:"v1"`. Overrides locais: `PIDGE_E2E_MEDIA=on` (força, p/ teste) / `off`
  (despina). **Pin de mídia (#313 estendido):** o primeiro send com mídia selada TRAVA o canal —
  daí em diante mídia que iria em claro é RECUSADA (exit 2, ANTES de qualquer byte subir), mesmo
  que o servidor diga que o gate fechou; só `PIDGE_E2E_MEDIA=off` local despina. Num send selado,
  `--image` com URL pública e ref pré-mintado são recusados (bytes fora da nossa custódia =
  media_enc mentiroso = foto quebrada no device).
- **pidge#367 F1: anexo INBOUND (você→agente).** Uma mensagem do composer pode carregar
  `attachment {filename, content_type, byte_size, url, enc?}` — `listen`/`--all` agora: anexo
  SELADO é SEMPRE baixado + desselado para `~/.config/pidge/downloads/<msg id>/<nome real>`
  (AAD `message_blob`/`message_filename`, ancorados no cid da MENSAGEM — campos distintos por
  direção matam replay cross-slot) e o JSON impresso ganha `attachment.path`; anexo claro passa
  com a `url` assinada (salve com `--download`, destino com `--download-dir DIR`). Filename é
  SANITIZADO antes de tocar disco (separadores/`..`/dot-leading); falha de decrypt = `e2e_error`
  preciso, ciphertext NUNCA vira arquivo. `body` pode vir `""` quando o anexo é a mensagem.
- `KNOWN_MANIFEST_VERSION` → **62** (manifest do sealed_media + inbound files).

## 0.19.0 — 2026-07-04

- **cli#47 / pidge#284 (LA v2): `pidge live` agora dirige os endpoints REAIS de Live Activity**
  (`POST/PATCH /api/v1/live_activities` + `/end`) — o degrade silencioso (`template_kind:live`
  → um 201 message-profile SEM card) morreu ([[cli-truth]]: nunca mais). Por default o card é
  uma ENTRADA do status center consolidado do usuário (decisão A do #284); `--dedicated` opta
  por card próprio (orçamento 2 — estourou, degrada ALTO com eco `degraded`/`reason` narrado
  no stderr). Novas flags: `--status --step N/M --progress --ends-at --starts-at --paused
  --resume --detail --symbol --dedicated --end --outcome --linger`. **`--step 3/5` é açúcar**:
  vira `progress: 0.6` + `progress_label` — não existe campo steps no wire. `--title` = POST
  (upsert por correlation_id); CID sem `--title` = PATCH (404 → dica de `--title`); `--end`
  conclui (✓ + outcome, linger default 30s). O JSON completo da resposta (com
  `operation: started|updated|noop|rotated|ended`) sai no stdout; `--wait` segue recusado.
- **Skill spine rev 6:** ensina o `pidge live` ligado (fields-drive-o-render, omit-to-preserve
  do timer, staleness server-side) e remove o aviso "silently degrades" + o bloco de curl cru.
- `KNOWN_MANIFEST_VERSION` → **60** (manifest do status center).


## 0.17.3 — 2026-07-04

- **#51 (fix, at-least-once):** `ack --up-to`/`--ids` agora exigem id NUMÉRICO inteiro (full-string)
  e morrem ALTO antes de qualquer HTTP. Antes, `parseInt` preguiçoso transformava um correlation_id
  colado ali ("9f2e…" → 9) num watermark errado que ackava mensagens nunca tratadas — perda
  silenciosa; e `--ids 12,abc` dropava o inválido em silêncio. A mensagem de erro ensina o
  namespace ("the NUMERIC id from listen output, never the correlation_id").
- **#52 (fix, doctor):** com o server ≥v57 (whoami either-track), `pidge doctor` com um SESSION
  token (`ses_`) no env dizia `key valid — canal "undefined"` e saía 0, escondendo a
  misconfiguração até o primeiro send 401ar. Agora diz "this is a SESSION token, not a channel
  key" e sai 2.
## 0.17.2 — E2E remediation texts point at the app's terminal step (#315-A, strings only)

- **help/doctor/error texts (no logic change):** the PIDGE_SECRET no longer travels
  in the setup prompt the human pastes in chat (app PR #328 made it a separate
  TERMINAL step on the Connect screen that writes `~/.config/pidge/env`). Every
  remediation string that said "re-run the setup prompt (it embeds the secret next
  to the token)" now points at that terminal step instead — and says NEVER to paste
  the secret in chat (a chat prompt is a log). Touched: `--help` ENV section,
  the invalid-secret runtime warning, the sealed-content pre-flight errors
  (`e2eSealedError`), and all four doctor E2E texts. Matches server manifest v54 —
  the two halves tell the same story. Wire format, sealing and exit codes unchanged.

## 0.17.1 — builtin/system action labels never seal (#313) · skill rev 5 (eval F1)

- **skill (SKILL_REVISION 4 → 5):** five surgical spine fixes, each one killing a
  failure PROVEN by the F1 eval baseline (16 fresh-agent scenarios, 2026-07-02 —
  all five re-ran PASS on the new text before this commit):
  - `--file`/`--image` documented (the media axis was absent — agents pasted
    digests but never attached the artifact);
  - **Live progress** section: the real Live Activity endpoints (upsert handle +
    explicit `end`) + the lighter `--collapse-key` path; heads-up that `pidge
    live` as a send silently degrades to a normal `message`-profile 201 today —
    no card ever starts (see #47 for the wiring); picker row updated accordingly;
  - supervisor-poll example now `listen --all` + explicit note that a pending
    notification's answer never surfaces in plain `listen` (recover via
    `wait <cid>` or `listen --all`);
  - `registered_devices:0` guidance says ABORT the blocking wait (not "don't
    wait" ambiguity);
  - (the "finishing a long task" nuance ships server-side in the manifest notes.)
- **usage (#44 item 1):** `pidge approve` now listed in the main `--help` USAGE
  (deny-default exit-code gate was undiscoverable from the top-level help).

- **fix (send, E2E):** the label of a custom action whose id is a builtin or
  system id — the server's 12 built-ins + `dismiss` + `acknowledge`
  (`Notification::RESERVED_ACTION_IDS`) — is NEVER sealed. Clients treat these
  ids as built-ins and SKIP label decrypt for them, so a sealed label (possible
  pre-fix only with id `acknowledge`, which the server didn't reject until
  manifest v52 closed the collision) would render raw `v1:…` on the button.
  Action IDs already rode clear; E3 will seal only CUSTOM labels. The never-seal
  list is exported (`E2E_NEVER_SEAL_LABEL_IDS`) and pinned by test to match the
  server's list.

## 0.17.0 — E2E v1 ON THE WIRE (#43, phase E2-CLI): sends seal, listen/wait decrypt

The send/receive wiring of end-to-end encryption (contract: `e2e-spec-v1.md`; server
manifest **v49** notifications passthrough + **v51** sealed `/messages`). With
`PIDGE_SECRET` configured and the channel E2E, content leaves the machine as ciphertext
the server cannot read, and sealed answers/messages decrypt back to plaintext locally.
Includes the E0 crypto lib + shared fixture (below), previously unreleased.

- **feat (send):** with a valid `PIDGE_SECRET` (same slot/precedence as `PIDGE_TOKEN`;
  the pair travels together) AND `e2e_enabled` on the channel (whoami says — never a
  guess), EVERY send path (`message/important/urgent/event/live`, `ask`, `approval`,
  `approve`, `hello`, deprecated `notify/send`) seals `title`/`subtitle`/`body`/
  `body_markdown` + **custom-action LABELS** (`action_label_<id>`; action IDs stay
  clear) and rides `enc:"v1"` + `kf` alongside. The `correlation_id` is ALWAYS minted
  client-side under E2E (the AAD needs it before the server sees the payload). No
  secret / non-E2E channel / whoami unreachable ⇒ the clear send of always — a missing
  secret must NEVER block a notification (the app marks it "⚠️ sem criptografia"). An
  INVALID secret warns loud and degrades to clear. Media note: `--image`/`--file` bytes
  + filename still ride CLEAR (phase E3) — narrated on stderr when sealing.
  The 201/upsert echo on stdout shows OUR OWN envelopes **decrypted for display**
  (trust-the-echo keeps meaning something; `enc`/`kf` stay printed as the wire truth).
- **feat (receive):** every read gates on the EXPLICIT `enc` flag — never on sniffing
  the `v1:` prefix. `listen` (WS and polling paths) opens sealed `kind:"message"` rows
  (E1.5: field ALWAYS `"message"`, AAD `ch<channel_id>:<correlation_id>:message` — the
  cid comes on the row) and `notification_reply` rows whose `ref.enc` is set (text =
  field `"reply"` with `ref.correlation_id`; `ref.title` = field `"title"`; a body that
  mirrors a custom-action label = `action_label_<action_id>`). `wait`/`ask`/`approve`/
  `hello` open the poll's `chosen_action` (text = `"reply"`, custom label =
  `action_label_<id>`) — the poll payload has no channel id, so whoami resolves it once.
  On success the plaintext replaces the ciphertext and `enc`/`kf` become
  `e2e:"decrypted"`; rows WITHOUT `enc` render exactly as before (pre-E2E history stays
  clear — honest degradation).
- **feat (precise errors — never garbage):** a sealed thing the CLI can't open is
  BLANKED (`body`/`text` → `null` + `e2e_error`) with ONE precise stderr line per
  distinct reason — base64 never reaches the terminal (follow-up A1). The reasons are
  named: **kf mismatch** ("sealed with ANOTHER key", both fingerprints shown — the
  token-of-one-channel + secret-of-another mixup), **enc without correlation_id**
  (server predates E1.5 / bug), **unknown envelope version**, **no (valid)
  PIDGE_SECRET**, and a failed tag. A NON-envelope value inside a sealed context is
  readable text and passes through (a built-in action label, or a clear reply typed on
  a pre-E2E app — the same accept-and-mark honesty the iOS app shows).
- **feat (doctor):** validates `PIDGE_SECRET` when present (base64url, exactly 32
  bytes; narrates the kf = `base64url(SHA-256(key)[0..3])`, never the secret) and
  crosses it with the channel: `e2e_enabled` + no secret → points at re-running the
  setup prompt (warning); secret + non-E2E channel → ORPHAN-secret warning; E2E channel
  + invalid/mismatched secret → **BROKEN, exit 2**. The stdout JSON gains
  `e2e: {channel, secret, kf}`.
- **feat (setup):** the `{TOKEN, SECRET}` pair travels together — `setup --claim`
  persists `PIDGE_SECRET` from the environment (the human's setup prompt embeds it)
  next to the token in the config file, and `--print` emits the
  `export PIDGE_SECRET=…` line alongside the other two. A secret already in the file
  is never silently dropped on a re-claim.
- **test:** `test/e2e-wire.test.js` — 17 wire tests against the mock server: sealed
  send (envelopes + enc/kf/cid + clear IDs + echo decrypt), the three clear-send
  degrades, sealed-message listen, `--all` reply-ref decrypt (text/title/label +
  narration), chosen_action decrypt (text, custom label, built-in passthrough), the
  precise-error matrix (kf mismatch, missing cid, unknown version, missing secret),
  and the A1 safety net (an unattributable envelope is blanked, never printed). The
  frozen fixture (`test/e2e_vectors.json`, sha `7bdacd01…`) is untouched; the mock
  gains `e2e_enabled` on whoami + the prod-shaped 201 content echo.
- **docs:** README E2E section + `PIDGE_SECRET` in `--help`'s ENV;
  `KNOWN_MANIFEST_VERSION` 46 → 51.

### E0 (#180), first released here: crypto lib + shared test vectors

The first increment of E2E encryption (contract: `e2e-spec-v1.md`, ratified 2026-07-02) —
the pure primitives + the cross-repo fixture the wiring above builds on.

- **feat (E0):** AES-256-GCM primitives inside `bin/pidge.js` (single-file, Node `crypto`
  only — zero new deps): `e2eEncryptField`/`e2eDecryptField` (`"v1:" + base64url(nonce ||
  ct || tag)`, one independent envelope per field), `e2eEncryptBlob`/`e2eDecryptBlob`
  (binary framing `[0x01][nonce][ct][tag]`, no base64), `e2eAad`
  (`ch<channel_id>:<correlation_id>:<field_name>` — anti-swap binding),
  `e2eKeyFingerprint` (`kf` = 4 bytes of SHA-256(key), base64url) and `e2eLoadSecret`
  (`PIDGE_SECRET` from the SAME slot/precedence as `PIDGE_TOKEN`: env wins over the
  per-agent-aware config file — wired into the commands by E2-CLI above). Decrypt fails
  LOUD and precisely:
  wrong AAD/corrupted tag, unknown version prefix (`v9:`), invalid base64url, wrong sizes.
  The nonce is `crypto.randomBytes(12)` in production; injectable ONLY for the fixture.
- **test (E0):** `test/e2e_vectors.json` — the SHARED deterministic fixture (committed
  byte-identical in the product repo too; server/iOS assert the SAME bytes — the cross-SDK
  gate) + its generator `test/gen-e2e-vectors.js` (not published). Cases: short field,
  unicode/emoji, >10 KB markdown, small binary blob, reply, wrong AAD, corrupted tag,
  unknown version, kf mismatch. `test/e2e.test.js` round-trips every vector, asserts every
  failure case, pins the fixture against drift, and covers `e2eLoadSecret` precedence.
  A require() test seam exports the pure helpers without running the CLI (`require.main`
  guard) — executing `pidge` as a binary is byte-for-byte unchanged.

## 0.16.1 — hardening lote (#38 #39 #40 #41): atomic self-heal, NaN fail-closed, CI, docs

Coordination-review batch (2026-07-01): two proven correctness holes closed, the repo's
first CI, and the docs reconciled with what 0.16.0 actually does.

- **fix (#38):** the skill self-heal is now ATOMIC — `SKILL.md` is written to a per-process
  tmp file + `renameSync`, so a killed process/full disk leaves the old skill intact and
  concurrent heals can't tear each other. The marker scan is ANCHORED (line 1 or inside the
  opening frontmatter block) — body prose like `pidge-skill rev=99` can't suppress a heal.
  Every generated skill now ends with a `<!-- pidge-skill-end -->` trailer: a marker without
  the trailer = a TORN write, detected and re-healed (pre-#38 it read as "fresh" forever).
  Overwriting a differing `SKILL.md` saves `SKILL.md.bak` + one stderr line — customizations
  are never clobbered silently. `SKILL_REVISION` 3 → 4.
- **fix (#39):** `--timeout`/`--interval` typos no longer hang the blocking commands FOREVER.
  `parseInt('abc')` → NaN made `doWait`'s deadline unreachable, so wait/ask/approve/hello/
  listen polled eternally and `approve`'s deny-default timeout branch was dead code. Now an
  unparseable value dies immediately (exit 1, fail-closed) BEFORE anything is sent — no ghost
  approval on the phone. `approve` also traps SIGINT → exit 1 with the deny-default narration.
- **ci (#40):** first CI — GitHub Actions runs `npm ci && node --test` on Node 18/20/22 for
  every push to main + every PR (no secrets; the suite uses the local mock server).
- **docs (#41):** the README showcase `ask --actions yes,no,reply` (broken since 0.16.0's
  decision+reply refusal) is fixed; `pidge approve` is documented (commands table, quick-start,
  "New in" banner through 0.16.x); the env TRUST CAVEAT is spelled out in `--help` and README
  (the gate is only as trustworthy as `PIDGE_URL`/`PIDGE_TOKEN`); the approve exit-code doc now
  tells the truth (HTTP failure on the send → 1; ONLY a raw network error → 2); the GitHub repo
  description no longer says "Herald". Two docs-drift guard tests keep it that way.

## 0.16.0 — #34 `pidge approve` (hook-shaped gate) + lote-5 polish

**`pidge approve "<question>"`** — a new, hook-shaped permission gate for wrapping an agent's
OWN risky actions behind a human Face-ID tap. It sends an important/sensitive notification with
two gated custom actions (`allow` = Face-ID confirm, `deny` = destructive), blocks on the same
long-poll as `pidge ask`, and maps the answer to an **exit code, DENY-DEFAULT**: only an explicit
`allow` is exit 0; deny, timeout, a dead channel, or any ambiguity is non-zero — so a Claude Code
`PreToolUse` hook fails CLOSED. `chosen_action` JSON is printed to stdout. Zero server change (a
thin wrapper over the existing send + wait). `--help` documents a runnable `PreToolUse` hook.

- **feat (#34):** `pidge approve` verb + `--allow-label`/`--deny-label`. `doWait`/`realtimeWait`/
  `waitForAnswer` gained optional `onAnswer`/`onTimeout` callbacks so a caller can map the
  outcome to an exit code instead of the default print-and-exit-0.
- **feat (lote-5 #2):** the CLI now REFUSES a decision button + `reply` in one send (e.g.
  `--actions yes,no,reply`) — exit 1, no round-trip. The human would tap the easy Yes/No and you'd
  get a useless "Yes" instead of the typed text (the skill's anti-slop rule #4, now enforced).
  `reply` alongside a non-decision (e.g. `done,reply`) stays allowed.
- **fix (lote-5 #3):** `pidge <type> --help` no longer prints a bare, description-less `template`
  line (`template` is intentionally off the menu; it stays a silent back-compat input).
- **feat (lote-5 #4):** `setup --quiet` collapses onboarding to a single status line (the full
  doctor stays the default; `--quiet` is opt-in and never hides a broken setup — warnings/errors
  still print).
- **feat (lote-5 #5):** `listen --all` now WARNS when its first quick batch is old backlog
  ("N message(s) were ALREADY queued when this listen started … NOT fresh arrivals"), so a
  resurfaced notification answer isn't mistaken for a new event. Within-channel — NOT the
  cross-channel leak (#289).
- **note (lote-5 #1):** the `ask`/`wait` fallback poll cadence is already 30 s (aligned to the
  server's suggestion); `--interval` still overrides. No change needed.
- **chore:** `SKILL_REVISION` 2 → 3 — the installed skill spine now teaches `pidge approve` and
  the decision-vs-reply refusal, so onboarded agents self-heal to it on their next command.

## 0.15.3 — #33 fix: the self-heal marker no longer corrupts the skill

The 0.15.2 marker was written as the FIRST line of `SKILL.md`, ABOVE the opening `---`. A
SKILL.md whose first line isn't `---` fails Claude Code's YAML frontmatter parse: the skill
still appears, but with a GARBAGE description (the HTML comment leaks in as the description and
the real `name`/`description` are lost) — so the agent's Claude Code never learns WHEN to use
Pidge. Verified on a live headless `claude` run: a marker-first probe skill loaded with its
description showing `<!-- pidge-skill … -->` instead of its real text, while an identical
`---`-first control loaded correctly.

- **fix:** the marker now rides a `# pidge-skill rev=R manifest=N` YAML COMMENT INSIDE the
  frontmatter (a `#` comment is valid YAML and invisible to `name`/`description`), so the
  frontmatter opens on line 1 and parses cleanly while the marker still travels with the file.
- **fix:** `ensureSkillFresh()` reads the marker from its new in-frontmatter position and still
  tolerates the old line-1 `<!-- … -->` marker, so a 0.15.2 install is detected as stale.
- **fix:** `SKILL_REVISION` bumped 1 → 2, so every 0.15.2 install (all rev=1, all broken) is
  seen as stale and self-heals into the corrected format on the next command — zero human action.

## 0.15.2 — #280 the skill self-heals

#280 — the local skill self-heals: any pidge command silently refreshes
`.claude/skills/pidge/SKILL.md` when the skill revision or manifest version is newer than
what's installed, so onboarded agents always run the latest skill.

- **feat:** a bumpable `SKILL_REVISION` constant + the live manifest version are baked into a
  first-line marker (`<!-- pidge-skill rev=R manifest=N -->`) of every generated `SKILL.md`.
  `ensureSkillFresh()` (run from `checkManifestNews`, which already fires on every command via
  the `x-pidge-manifest-version` header) compares the installed marker against this CLI's spine
  and the server's manifest; when either is newer it silently regenerates the skill and prints
  one stderr note. Only an EXISTING skill is refreshed (never auto-created), at most once per
  process, fully best-effort (a refresh failure never breaks your command), and `QUIET_NAG`
  suppresses the note (the regenerate still happens).
- **note:** this composes with `@latest` — an agent on `npx pidge-cli@latest` picks up a new
  `SKILL_REVISION` and self-heals the spine on its next command. A PINNED CLI still self-heals
  on a server manifest bump (via the header) but can't gain a newer hand-authored spine without
  updating the CLI. BUMP `SKILL_REVISION` in any future sprint that edits the SKILL.md spine.

## 0.15.1 — #274-D skill polish

skill polish — catalog-first actions, write-for-the-lock-screen (banner = title+body; body_markdown is detail-only), good-report guidance; gold examples now set a plain --body.

## 0.15.0 — #274 CLI redesign (F1)

-m/--body-markdown-file input chain, --gated, English hello, --template off the help menu (still accepted), nag knows v46, --wait defaults to 60 min for decisions.

F3/F4: skill rewritten (two approval paths, English gold examples, no content_template menu, appendix from v46); setup → skill → hello fuse with graceful-degrade.

## 0.14.0 — 2026-06-28

The married vocabulary (perfis) — the CLI now speaks the SAME language as the server
(manifest v42) and the app: ONE list of 5 message types, with RESPONSE as a separate
axis. No scripts break — the old names keep working as aliases.

- **feat:** the typed sends are renamed to the canonical 5 — `pidge message` ·
  `important` · `urgent` · `event` · `live` (message←fyi, important←report, urgent←alert;
  event/live unchanged). `important` is the recommended default. The wire sends the new
  `template_kind`. (perfis-S1)
- **feat (compat):** the OLD names still work as aliases — `pidge fyi`→message,
  `report`→important, `alert`→urgent — mapped to the new type, with a one-line rename
  note on stderr. Muscle-memory and existing scripts are untouched. (perfis-S1)
- **feat:** RESPONSE is now its own axis, composing on ANY type — `--actions`/
  `--custom-action` (buttons) + the new **`--wait`** (block until the human answers,
  then print `chosen_action` JSON; without it = fire-and-forget). This is the explicit
  "send-and-go vs wait". (perfis-S2)
- **feat:** `pidge ask` is now the shortcut for `important --wait` (still REQUIRES a way
  to answer; preserved behavior). There is no `ask` TYPE in the married catalog — asking
  is a type + buttons + wait. (perfis-S2)
- **feat:** `pidge approval` — a new go/no-go RECIPE = `important` + Approve/Reject +
  Face ID on Approve + `--wait`. Sent as `custom_actions` (only custom actions carry
  `biometric`, and a custom id can't reuse a built-in like approve/reject — so the ids
  are `grant`/`deny`). Pass your own `--actions`/`--custom-action` to override the
  pair. (perfis-S2)
- **docs:** USAGE, per-command help and the generated `SKILL.md` rewritten around the two
  axes (type + response) — mirrors the human's app, drops the dead fyi/report framing.
- **chore:** `KNOWN_MANIFEST_VERSION` 36 → 42 (the live server), silencing the news nag.

## 0.13.1 — 2026-06-26

Polish from an agent E2E (2026-06-26). No breaking changes.

- **fix:** the manifest-version nudge no longer scolds "your CLI is stale, UPDATE it".
  pidge is a thin pipe — `--param KEY=VALUE` carries any new `/notify` field NOW, so a
  server manifest bump almost never needs a CLI release. The nudge is reframed as "new
  capabilities + how to use them today" and `KNOWN_MANIFEST_VERSION` is bumped 31 → 36
  (the current server), silencing the false-positive on `@latest`. (#26)
- **fix:** the public manifest (#249-A) curl in that nudge drops the mandatory Bearer —
  the catalog reads without a key; the Bearer is shown only as the optional way to also
  see the channel's own config. (#26)
- **fix:** the realtime reconnect log no longer reads "realtime socket **socket** closed"
  (doubled word) and the counter no longer sticks at "attempt 1/4" — it now shows a
  monotonic "reconnect #N" so a connect→drop flap visibly advances instead of looking
  like a stuck loop. (#25)

## 0.13.0 — 2026-06-25

Template system (#246) — the agent now declares an intent TYPE; the server maps it to
the human's delivery profile (the human never sees the type). Soft-rollout: typeless
sends still work in 0.13.x (server falls back to `fyi`); 0.14 will require a type.

- **feat:** 6 type subcommands — `pidge fyi` · `report` · `ask` · `event` · `alert` ·
  `live`. Each stamps `template_kind` on the `/notify` payload. fyi/report/event/alert/
  live are fire-and-forget (like `notify`); `ask` send+waits for the answer. (#246)
- **feat:** `pidge notify` (and `pidge send`) is **deprecated** with a local warning —
  it still works for one minor (0.13.x; the server falls back to `fyi`) and will 422 in
  0.14. Use a typed send instead. (#246)
- **feat:** local validation before the round-trip — `ask` requires a way to answer
  (`--actions`, `--custom-action`, or a `--template` that supplies them); `event`
  requires a valid ISO8601 `--event-at`. Friendly exit-1 errors, nothing sent. (#246)
- **feat:** `alert --escalate` adds `escalate: true` (ask the Urgente profile for an
  AlarmKit alarm that breaks through silent/Focus; the human's profile decides). (#246)
- **feat:** an unknown subcommand now points at the type catalog instead of dumping the
  whole USAGE; `pidge <type> --help` shows each typed send's own flags. (#246)
- **docs:** `pidge skill install` writes a **"Choose the right type"** catalog table
  into the generated `SKILL.md`. (#246)

## 0.12.0 — 2026-06-25

CLI bugs batch, all reported by an agent in real production use. No breaking changes.

- **fix:** `pidge <sub> --help` shows the SUBCOMMAND's own help (its synopsis + own
  flags), not the global USAGE dump — e.g. `pidge ask --help` now leads with ask's
  `--actions`/`--timeout` instead of burying them. `pidge --help` and `pidge help`
  still show the full command overview; `pidge help <cmd>` is the focused form. (#240)
- **feat:** the "server has new capabilities" manifest-version nag is throttled to
  **once per 24 h** (cached in `~/.config/pidge/state.json`, per-agent when
  `PIDGE_AGENT` is set) and only re-fires when the server version actually changed —
  no more a nag on every call. New `--quiet-nag` flag and `PIDGE_QUIET_NAG=1` env to
  silence it entirely (scripts/CI). (#241)
- **feat:** `--actions` accepts a **JSON array** of custom `{id,label,…}` actions for
  custom labels — `--actions '[{"id":"approve","label":"Aprovar agora"},{"id":"defer","label":"Deixa pra amanhã"}]'`.
  A leading `[` selects JSON; bad JSON / a missing `id`/`label` is a friendly LOCAL
  error (exit 1, nothing sent). The short form `--actions yes,no,reply` is unchanged,
  and JSON composes with `--custom-action`. (#242)
- **docs:** the manifest re-read instruction (the version nag) now shows the
  **authenticated** curl — `curl -H "Authorization: Bearer $PIDGE_TOKEN" $PIDGE_URL/api/v1/manifest`
  — so an agent that follows it doesn't take a 401. (#243)
- **docs:** `pidge skill install` now writes an **"always-on for turn-based agents"**
  recipe into the generated `SKILL.md` — an interactive listening window
  (`pidge listen --follow`) and a no-daemon supervisor poll (looped one-shot
  `pidge listen`). (#244)
