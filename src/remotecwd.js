// Directorio actual del shell de una conexión SSH, sin escribir nada en él: en un canal aparte de la misma
// conexión se busca al proceso sshd que la atiende, su hijo con terminal (el shell) y el programa en primer
// plano de esa terminal, y se lee su directorio de /proc (o con lsof donde no hay /proc).
// El script va por la entrada estándar, así no depende del shell de inicio del usuario (csh, fish…).
const PROBE = `T=$(ps -eo pid=,ppid=,tty=,tpgid=,comm= 2>/dev/null | awk -v me=$$ '
{ pp[$1] = $2; tty[$1] = $3; fg[$1] = $4; cmd[$1] = $5 }
END {
  p = me
  for (n = 0; n < 64 && p > 1 && cmd[p] !~ /(^|\\/)(sshd|dropbear)/; n++) p = pp[p]
  if (cmd[p] !~ /(^|\\/)(sshd|dropbear)/) exit
  for (i in pp) if (pp[i] == p && tty[i] !~ /^\\?/ && fg[i] > 0) { print fg[i]; exit }
}')
[ -n "$T" ] || exit 0
D=$(readlink "/proc/$T/cwd" 2>/dev/null)
[ -n "$D" ] || D=$(lsof -a -p "$T" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
[ -n "$D" ] && printf '@rxcwd:%s\\n' "$D"
`;

// Un .bashrc puede imprimir texto en cualquier canal: sólo vale la línea marcada
function parseCwd(out) {
  const found = String(out).match(/^@rxcwd:(\/.*)$/gm);
  if (!found) return null;
  const dir = found[found.length - 1].slice('@rxcwd:'.length).replace(/\r$/, '');
  return dir.endsWith(' (deleted)') ? null : dir;
}

function remoteCwd(client, timeout = 4000) {
  return new Promise((resolve) => {
    let out = '';
    let stream = null;
    const timer = setTimeout(() => { resolve(null); if (stream) stream.close(); }, timeout);
    const finish = (value) => { clearTimeout(timer); resolve(value); };
    try {
      client.exec('sh -s', (err, st) => {
        if (err) return finish(null);
        stream = st;
        st.on('data', (d) => { if (out.length < 65536) out += d; });
        st.stderr.on('data', () => {});
        st.on('close', () => finish(parseCwd(out)));
        st.end(PROBE);
      });
    } catch { finish(null); }
  });
}

module.exports = { remoteCwd, parseCwd, PROBE };
