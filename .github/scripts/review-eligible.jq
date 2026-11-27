(.draft == false) and
(.state == "open") and
(.head.repo.full_name == $repository) and
(.user.type == "User") and
(.user.login != "dependabot[bot]")
