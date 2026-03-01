---
title: Skins
layout: default
---

<ul>
{% assign skins_files = site.static_files | where_exp:"item","item.path contains 'skins/'" %}
{% for file in skins_files %}
  <li><a href="{{ file.path }}">{{ file.path | remove_first:'/' }}</a></li>
{% endfor %}
</ul>
